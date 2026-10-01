"""server/routers/analytics.py — 比赛 / 重播 / 统计 / 排行榜"""
from fastapi import APIRouter, HTTPException, Query

import db

router = APIRouter()


@router.get("/tournaments/{local_id}/matches")
def tournament_matches(local_id: int):
    t = db.get_tournament(local_id)
    if not t:
        raise HTTPException(404, "赛事不存在")
    return db.list_matches_rows(t["tournament_id"])


@router.get("/tournaments/{local_id}/leaderboard")
def tournament_leaderboard(local_id: int):
    t = db.get_tournament(local_id)
    if not t:
        raise HTTPException(404, "赛事不存在")
    snap = db.get_leaderboard_snapshot(t["tournament_id"])
    return {
        "tournament_id": t["tournament_id"],
        "our_team_id": t["team_id"],
        "snapshot": snap,  # None 表示尚未拉取
    }


@router.get("/matches/{match_id}")
def match_detail(match_id: str):
    m = db.get_match_full(match_id)
    if not m:
        raise HTTPException(404, "未找到该比赛，请先拉取数据")
    return m


@router.get("/matches/{match_id}/replay")
def match_replay(match_id: str):
    data = db.get_replay(match_id)
    if data["tick_count"] == 0:
        raise HTTPException(404, "本场无 tick 数据（赛后保留期已过或上游未返回 prompts）")
    return data


@router.get("/stats")
def stats(tournament_id: int = Query(None, description="本地 tournaments.id；缺省全部")):
    if tournament_id is not None:
        t = db.get_tournament(tournament_id)
        if not t:
            raise HTTPException(404, "赛事不存在")
        return db.get_stats(t["tournament_id"])
    return db.get_stats()
