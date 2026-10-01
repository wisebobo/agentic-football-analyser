"""server/routers/fetch.py — 手动拉取 + 拉取日志"""
from fastapi import APIRouter, HTTPException, Query

import db
import fetch_service

router = APIRouter()


@router.post("/{local_id}/fetch")
def fetch_now(local_id: int, force: bool = Query(False, description="强制重拉已结束比赛")):
    if not db.get_tournament(local_id):
        raise HTTPException(404, "赛事不存在")
    try:
        return fetch_service.fetch_tournament(local_id, force=force)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/{local_id}/fetch-runs")
def fetch_runs(local_id: int, limit: int = Query(20, ge=1, le=100)):
    if not db.get_tournament(local_id):
        raise HTTPException(404, "赛事不存在")
    return db.list_fetch_runs(db.get_tournament(local_id)["tournament_id"], limit)
