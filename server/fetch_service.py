"""
server/fetch_service.py — 手动拉取编排（matches 增量 + leaderboard 全量快照 + fetch_runs 日志）
同步执行；单场失败不阻塞整体；上游全挂时降级（incomplete + 错误摘要）。
"""
import json

import db
import fetcher

FINISHED = {"finished", "completed", "ended"}


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
            item_status = it.get("status")
            saved = db.match_status(mid)
            if saved and str(item_status or "").lower() in FINISHED and not force:
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
