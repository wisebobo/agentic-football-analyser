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

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

import db

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
def unity_matches():
    """列出本地库所有可回放比赛（含 relay 需要的 vendor_match_id）。"""
    con = sqlite3.connect(f"file:{db.DB_PATH}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT detail_json, home_team_name, away_team_name, home_score,"
        " away_score, status, starting_at, our_side, is_practice"
        " FROM matches ORDER BY COALESCE(starting_at, fetched_at) DESC"
    ).fetchall()
    con.close()
    out = []
    for dj, hn, an, hs, as_, st, sa, side, prac in rows:
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
