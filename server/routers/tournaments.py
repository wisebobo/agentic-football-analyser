"""server/routers/tournaments.py — 赛事配置（不可变）"""
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import db
import fetcher

router = APIRouter()

DEFAULT_BASE_URL = "https://l3fmtx4zp0.execute-api.us-east-1.amazonaws.com/prod"


class TournamentIn(BaseModel):
    team_code: str
    tournament_id: str
    base_url: str = DEFAULT_BASE_URL


@router.post("")
def create_tournament(body: TournamentIn):
    code = body.team_code.strip()
    tid = body.tournament_id.strip()
    if not code or not tid:
        raise HTTPException(400, "team_code / tournament_id 不能为空")
    if db.tournament_exists_code(code):
        raise HTTPException(409, "该 team code 已创建赛事，配置不可变")

    client = fetcher._client()
    try:
        detail, derr = fetcher.fetch_tournament(client, body.base_url, code, tid)
        if derr:
            raise HTTPException(422, f"上游校验 /tournaments/{tid} 失败: {derr}")
        mine, merr = fetcher.fetch_mine_team(client, body.base_url, code)
        if merr:
            raise HTTPException(422, f"上游校验 /teams/mine 失败: {merr}")
    finally:
        client.close()

    local_id = db.create_tournament(
        team_code=code,
        tournament_id=(detail or {}).get("tournament_id") or tid,
        team_id=mine["team_id"],
        team_name=mine.get("name") or mine.get("team_name") or "",
        tournament_name=(detail or {}).get("name"),
        detail_json=json.dumps(detail, ensure_ascii=False),
        base_url=body.base_url,
    )
    return db.get_tournament(local_id)


@router.get("")
def list_tournaments():
    return db.list_tournaments()


@router.get("/{local_id}")
def get_tournament(local_id: int):
    t = db.get_tournament(local_id)
    if not t:
        raise HTTPException(404, "赛事不存在")
    return t
