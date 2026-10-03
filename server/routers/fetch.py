"""server/routers/fetch.py — 手动拉取 + 拉取日志 + 练习赛触发 + 自动开关"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

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


@router.post("/{local_id}/practice-match")
def practice_match_now(local_id: int):
    """立即手动触发 1 次练习赛（按 team_code 维度轮换 aggressive/balanced/defensive，
    与后台定时任务共享同一轮换指针）。"""
    if not db.get_tournament(local_id):
        raise HTTPException(404, "赛事不存在")
    try:
        return fetch_service.trigger_practice_match(local_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


class AutoIn(BaseModel):
    enabled: bool


@router.post("/{local_id}/auto")
def set_auto(local_id: int, body: AutoIn):
    """设置该赛事是否纳入后台定时任务（拉数据 + 练习赛），下一周期生效，无需重启。"""
    if not db.get_tournament(local_id):
        raise HTTPException(404, "赛事不存在")
    db.set_auto_enabled(local_id, 1 if body.enabled else 0)
    return db.get_tournament(local_id)
