"""
server/fetch_service.py — 手动拉取编排（matches 增量 + leaderboard 全量快照 + fetch_runs 日志）
同步执行；单场失败不阻塞整体；上游全挂时降级（incomplete + 错误摘要）。
"""
import json

import db
import fetcher

FINISHED = {"finished", "completed", "ended"}
# 库里已是这些状态的比赛不再重拉（cancelled 永远不会有比分，避免每轮白白刷新）
NO_REFRESH = FINISHED | {"cancelled"}

# ---------- 练习赛对手轮换 ----------
_PRACTICE_OPPONENTS = ["aggressive", "balanced", "defensive"]
# key: team_code, value: 下一个要用的索引（0-based）。进程重启后清空，自然从 aggressive 开始。
_rotation: dict = {}


def _next_opponent(team_code: str) -> str:
    idx = _rotation.get(team_code, 0)
    opp = _PRACTICE_OPPONENTS[idx]
    _rotation[team_code] = (idx + 1) % len(_PRACTICE_OPPONENTS)
    return opp


def trigger_practice_match(local_id: int) -> dict:
    """对该赛事触发 1 次练习赛（按 team_code 维度轮换 aggressive/balanced/defensive）。"""
    t = db.get_tournament(local_id)
    if not t:
        raise ValueError(f"tournament #{local_id} 不存在")
    opponent = _next_opponent(t["team_code"])
    client = fetcher._client()
    try:
        data, err = fetcher.trigger_practice_match_upstream(
            client, t["base_url"], t["team_code"], t["team_id"], opponent)
    finally:
        client.close()
    return {"opponent": opponent, "ok": err is None, "err": err, "response": data}


def fetch_tournament(local_id: int, force: bool = False) -> dict:
    t = db.get_tournament(local_id)
    if not t:
        raise ValueError(f"tournament #{local_id} 不存在")
    base, code, tid = t["base_url"], t["team_code"], t["tournament_id"]
    our_team_id = t["team_id"]

    rid = db.fetch_run_start(tid)
    seen = new_n = refreshed = skipped = failed = 0
    lb_rows = 0
    incomplete = False
    errors = []

    client = fetcher._client()
    try:
        # 1) 比赛列表（上游限制：最近 20 场）
        listing, err = fetcher.list_matches(client, base, code, our_team_id)
        items = []
        if err:
            errors.append(f"比赛列表: {err}")
        else:
            items = (listing or {}).get("items", []) or []
        seen = len(items)

        # 2) 逐场增量
        for it in items:
            mid = it.get("id") or it.get("match_id")
            if not mid:
                continue
            saved = db.match_status(mid)
            # 以"库里已存的状态"判断是否跳过：库里的快照若是终态则无需重拉；
            # 若库里是 in_progress 等中间态，即使上游列表已显示 completed，
            # 也必须重拉详情以回填比分（否则无比分快照会永远滞留）。
            if saved and str(saved or "").lower() in NO_REFRESH and not force:
                skipped += 1
                continue
            detail, derr = fetcher.fetch_match_detail(client, base, code, mid)
            if derr:
                failed += 1
                errors.append(f"match {mid[:8]} 详情: {derr}")
                continue
            prompts, perr, pmeta = fetcher.fetch_prompts_all(client, base, code, mid)
            if perr:
                incomplete = True
                errors.append(f"match {mid[:8]} prompts 不完整: {perr}")
            db.save_match(match_id=mid, tournament_id=tid, team_id=our_team_id,
                          detail=detail, prompts=prompts)
            if saved:
                refreshed += 1
            else:
                new_n += 1

        # 3) 积分榜全量快照
        standings, serr, smeta = fetcher.fetch_standings_all(client, base, code, tid)
        if serr:
            incomplete = True
            errors.append(f"积分榜: {serr}")
        lb_rows = db.save_leaderboard_snapshot(tid, standings)
    finally:
        client.close()
        db.fetch_run_finish(
            rid, matches_seen=seen, new_matches=new_n, refreshed=refreshed,
            skipped=skipped, failed=failed, leaderboard_rows=lb_rows,
            incomplete=incomplete,
            error_text=("; ".join(errors)[:2000]) or None,
        )

    run = db.list_fetch_runs(tid, 1)[0]
    return json.loads(json.dumps(run))
