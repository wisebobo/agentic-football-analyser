"""server/routers/unity.py — Unity WebGL 回放 API

三个端点：
  GET /unity/matches             本地比赛列表（含 vendor_match_id）
  GET /unity/replays/{id}       回放二进制（本地缓存优先，miss 时从 relay 下载并缓存）
  GET /unity/rproxy?u=          CORS 代理（服务端代拉远程 URL，绕过浏览器 CORS）

Unity 静态资源（.wasm/.data/.framework.js/loader.js/StreamingAssets/index.html）由
前端 Vite 从 frontend/public/unity/ 托管，本 router 只处理 API 语义的端点 +
回放二进制缓存（落在 server/data/replays/，与前端静态资源解耦）。
"""
import os
import json
import shutil
import sqlite3
import subprocess
import tempfile
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

import db
import replay_timeline

router = APIRouter()

# 回放二进制缓存目录（与前端托管的 Unity 静态资源分离，避免后端写入 frontend/）
REPLAYS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "data", "replays"))
os.makedirs(REPLAYS_DIR, exist_ok=True)

# relay 服务（Unity 客户端的回放源站）
RELAY_BASE = "https://game.agentic-football.aws.dev"


def _curl(url: str, out_path: str, timeout: int = 180) -> tuple[bool, str]:
    """curl 代拉（urllib 对本环境部分 CDN TLS 握手会失败，沿用 serve_unity.py 策略）。"""
    if shutil.which("curl") is None:
        return False, "curl 不可用"
    cmd = ["curl", "-sS", "--max-time", str(timeout), "--retry", "3",
           "--retry-delay", "2", "--fail", "-o", out_path, url]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout + 60, text=True)
    except subprocess.TimeoutExpired:
        return False, "curl 超时"
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:300]
    return True, proc.stderr.strip()[:300]


@router.get("/unity/matches")
def unity_matches(tournament_id: Optional[str] = Query(
    None, description="赛事 tournament_id 字符串；缺省返回全部（回放页按顶部所选赛事筛选）")):
    """列出本地库可回放比赛（含 relay 需要的 vendor_match_id）。

    可选 tournament_id 过滤：只返回该赛事下的比赛，与赛事配置/排行/分析/统计页一致。
    始终按比赛时间倒序（COALESCE(starting_at, fetched_at) DESC）。
    """
    con = sqlite3.connect(f"file:{db.DB_PATH}?mode=ro", uri=True)
    try:
        if tournament_id:
            rows = con.execute(
                "SELECT detail_json, home_team_name, away_team_name, home_score,"
                " away_score, status, starting_at, our_side, is_practice, tournament_id"
                " FROM matches WHERE tournament_id=?"
                " ORDER BY COALESCE(starting_at, fetched_at) DESC",
                (tournament_id,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT detail_json, home_team_name, away_team_name, home_score,"
                " away_score, status, starting_at, our_side, is_practice, tournament_id"
                " FROM matches ORDER BY COALESCE(starting_at, fetched_at) DESC"
            ).fetchall()
    finally:
        con.close()
    out = []
    for dj, hn, an, hs, as_, st, sa, side, prac, tid in rows:
        vid = json.loads(dj or "{}").get("vendor_match_id")
        if not vid:
            continue
        out.append({
            "vendor_match_id": vid,
            "match_id": None,
            "home": hn, "away": an,
            "home_score": hs, "away_score": as_,
            "status": st, "starting_at": sa,
            "our_side": side, "is_practice": bool(prac),
            "tournament_id": tid,
        })
    return {"count": len(out), "items": out}


@router.get("/unity/replays/{vendor_match_id}")
def unity_replay(vendor_match_id: str):
    """本地缓存优先；miss 时从 relay 下载并缓存到 REPLAYS_DIR。"""
    safe_id = vendor_match_id.replace("/", "_").replace("\\", "_")
    cache = os.path.join(REPLAYS_DIR, f"{safe_id}.msgpack.gz")
    if not os.path.exists(cache):
        url = f"{RELAY_BASE}/match/{safe_id}/replay"
        # 关键: temp 必须落在 REPLAYS_DIR 同卷 —— Windows 的 os.replace 不能跨
        # 磁盘驱动器移动文件（WinError 17）。默认系统 temp 在 C:，缓存目录在 E:。
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".msgpack.gz", dir=REPLAYS_DIR)
        tmp.close()
        try:
            ok, err = _curl(url, tmp.name)
            if not ok or not os.path.getsize(tmp.name):
                raise HTTPException(502, f"relay 下载失败: {err or '空响应'}")
            os.replace(tmp.name, cache)
        except HTTPException:
            if os.path.exists(tmp.name):
                os.unlink(tmp.name)
            raise
        except Exception as e:  # noqa: BLE001
            if os.path.exists(tmp.name):
                os.unlink(tmp.name)
            raise HTTPException(502, f"relay 下载失败: {e}")
    # 顺手把「播放时间轴」解出来缓存（几 KB），供同步面板用。
    # 失败不影响回放本体（面板会退化为「无 tick 数据」提示）。
    replay_timeline.ensure_timeline(REPLAYS_DIR, safe_id)
    return FileResponse(
        cache, media_type="application/octet-stream",
        filename=f"{safe_id}.msgpack.gz",
    )


@router.get("/unity/rproxy")
def unity_rproxy(u: str = Query(...)):
    """服务端代拉远程 URL 并原样返回（绕过浏览器 CORS）。空 u 用于探测。"""
    if not u:
        raise HTTPException(400, "missing ?u=")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".bin")
    tmp.close()
    try:
        ok, err = _curl(u, tmp.name)
        if not ok:
            raise HTTPException(502, f"proxy 拉取失败: {err}")
        with open(tmp.name, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="application/octet-stream")
    finally:
        os.unlink(tmp.name)


@router.get("/unity/replay-prompts/{vendor_match_id}")
def unity_replay_prompts(vendor_match_id: str):
    """逐 tick 的 gameState + 双方 agent 指令,供回放页同步展示。

    数据来自 DB 的 tick_prompts(db.get_replay 已归一化逐 tick 时间线),
    不依赖外部 API 实时拉取,也不走 gitignored 的 tools/ 旁路。
    """
    safe_id = vendor_match_id.replace("/", "_").replace("\\", "_")
    con = sqlite3.connect(f"file:{db.DB_PATH}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT match_id, detail_json FROM matches").fetchall()
    finally:
        con.close()
    match_id = None
    for mid, dj in rows:
        vid = json.loads(dj or "{}").get("vendor_match_id")
        if vid == safe_id:
            match_id = mid
            break
    if not match_id:
        raise HTTPException(404, "未找到该比赛(本地库无此 vendor_match_id)")
    data = db.get_replay(match_id)
    if not data.get("ticks"):
        raise HTTPException(404, "本场无 tick 数据(赛后保留期已过或上游未返回 prompts)")

    # 播放时间轴：回放是匀速逐帧序列，「进球庆祝 / 开球等待 / 赛前」这些段落里
    # gameTime 冻结但帧继续 ⇒ 同步轴必须是**帧序号**而非 gameTime，否则必然超前。
    # 每 tick 附带其在播放时间轴上的起始帧号，前端按帧推进即可自动"停在动画里"。
    tl = replay_timeline.ensure_timeline(REPLAYS_DIR, safe_id)
    if tl:
        for tk in data["ticks"]:
            tk["frame"] = replay_timeline.frame_for_tick(tl, tk.get("t"), tk.get("gameTime"))
        data["timeline"] = {
            "fps": tl["fps"],
            "total_frames": tl["total_frames"],
            "duration_sec": tl["duration_sec"],
            "tick_indexed": tl.get("tick_indexed", False),
            "segments": tl["segments"],
            # goals: [{f,s,gt,h,a,w0,w1}] —— f/w0/w1 分别为「进球帧 / 开球等待段起 / 恢复比赛帧」，
            # 用于把客户端 GOAL 与 Phase 日志逐条映射回帧号（持续重锚定）。
            "goals": tl.get("goals", []),
            # kickoff_frame: 仪式结束、正式开球（首个「比赛钟在走」的帧）。
            # 前端用「画面切成球场」的视觉时刻对齐到它 —— 不依赖客户端日志的兜底锚点。
            "kickoff_frame": tl.get("kickoff_frame"),
        }
        data["timeline_reason"] = None
    else:
        # 显式给出 null + 原因：前端才能区分「后端还没重启(整个字段缺失)」
        # 与「后端就绪但本场二进制尚未缓存(首播时正常，下载完重取即可)」。
        data["timeline"] = None
        data["timeline_reason"] = replay_timeline.timeline_reason(REPLAYS_DIR, safe_id)
    return data
