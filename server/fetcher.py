"""
server/fetcher.py — 上游取数层（httpx 版）
所有函数接收 base_url + team_code；全部请求 3 次重试（瞬态网络故障，退避 2/4/6s）。
鉴权：Authorization: Bearer team:<CODE>（code 不含 team: 前缀，统一补上）。
"""
import time
import urllib.parse

import httpx

HTTP_TIMEOUT = 60


def _headers(team_code: str) -> dict:
    code = (team_code or "").strip()
    if code.lower().startswith("team:"):
        code = code[len("team:"):]
    return {
        "accept": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Authorization": f"Bearer team:{code}",
    }


def _get(client: httpx.Client, base: str, path: str, team_code: str,
         retries: int = 3, retryable: bool = True):
    """返回 (data:dict|None, err:str|None)。瞬态故障重试 retries 次。"""
    err = None
    for attempt in range(retries if retryable else 1):
        try:
            r = client.get(base + path, headers=_headers(team_code))
            if r.status_code == 200:
                try:
                    return r.json(), None
                except Exception as e:
                    err = f"JSON 解析失败: {e}"
                    break  # 非瞬态，不重试
            err = f"HTTP {r.status_code}: {r.text[:240]}"
            if r.status_code < 500 and r.status_code not in (408, 429):
                break  # 4xx（除 408/429）不重试
        except Exception as e:  # 连接超时等瞬态故障
            err = f"{type(e).__name__}: {e}"
        if attempt < (retries if retryable else 1) - 1:
            time.sleep(2 * (attempt + 1))
    return None, err


def _post(client: httpx.Client, base: str, path: str, team_code: str,
          body: dict, retries: int = 3, retryable: bool = True):
    """与 _get 对称的 POST 版：2xx 成功；4xx(除408/429)不重试；5xx/网络异常重试 retries 次。
    返回 (data:dict|None, err:str|None)。"""
    err = None
    for attempt in range(retries if retryable else 1):
        try:
            r = client.post(base + path, json=body, headers=_headers(team_code))
            if r.status_code < 300:
                try:
                    return r.json(), None
                except Exception as e:
                    err = f"JSON 解析失败: {e}"
                    break  # 非瞬态，不重试
            err = f"HTTP {r.status_code}: {r.text[:240]}"
            if r.status_code < 500 and r.status_code not in (408, 429):
                break  # 4xx（除 408/429）不重试
        except Exception as e:  # 连接超时等瞬态故障
            err = f"{type(e).__name__}: {e}"
        if attempt < (retries if retryable else 1) - 1:
            time.sleep(2 * (attempt + 1))
    return None, err


def _client() -> httpx.Client:
    return httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True)


# ---------- 赛事 / 我的队伍 ----------

def fetch_tournament(client, base, team_code, tournament_id: str):
    return _get(client, base, f"/tournaments/{urllib.parse.quote(tournament_id)}", team_code)


def fetch_mine_team(client, base, team_code: str):
    """GET /teams/mine → (items[0] 或 None, err)。code 绑定的真实队伍。"""
    d, err = _get(client, base, "/teams/mine", team_code)
    if err:
        return None, err
    items = (d or {}).get("items") or []
    if not items:
        return None, "该 team code 名下没有队伍（/teams/mine 返回空）"
    return items[0], None


def trigger_practice_match_upstream(client, base: str, team_code: str,
                                   team_id: str, opponent: str):
    """POST /practice-matches → (data|None, err|None)。opponent ∈ {aggressive, balanced, defensive}。"""
    return _post(client, base, "/practice-matches", team_code,
                 {"team_id": team_id, "opponent": opponent})


# ---------- 比赛列表 / 单场 ----------

def list_matches(client, base, team_code, team_id: str):
    return _get(client, base, f"/matches?team_id={urllib.parse.quote(team_id)}", team_code)


def fetch_match_detail(client, base, team_code, match_id: str):
    return _get(client, base, f"/matches/{urllib.parse.quote(match_id)}", team_code)


def fetch_agent_stats(client, base, team_code, match_id: str):
    return _get(client, base, f"/matches/{urllib.parse.quote(match_id)}/agent-stats", team_code)


def fetch_report(client, base, team_code, match_id: str):
    return _get(client, base, f"/matches/{urllib.parse.quote(match_id)}/report", team_code)


def fetch_prompts_all(client, base, team_code, match_id: str, max_pages: int = 1000):
    """翻页拉全部 tick 数据，返回 (list, err, meta)。每页 50 条。"""
    mid = urllib.parse.quote(match_id)
    allp, tok, page = [], None, 0
    while True:
        path = (f"/matches/{mid}/prompts?next_token={urllib.parse.quote(tok)}"
                if tok else f"/matches/{mid}/prompts")
        d, err = _get(client, base, path, team_code)
        if err:
            meta = {"pages": page, "capped": page >= max_pages, "total": len(allp)}
            return allp, err, meta
        allp += (d or {}).get("prompts", []) or []
        page += 1
        tok = (d or {}).get("next_token")
        if not tok or page >= max_pages:
            break
    meta = {"pages": page, "capped": bool(tok), "total": len(allp)}
    return allp, None, meta


# ---------- 积分榜 ----------

def fetch_standings_all(client, base, team_code, tournament_id: str, max_pages: int = 50):
    """next_token 循环拉全量积分榜，返回 (items, err, meta)。每页 100 条。"""
    tid = urllib.parse.quote(tournament_id)
    all_items, tok, page = [], None, 0
    meta = {"pages": 0, "total_teams": None, "incomplete": False}
    while True:
        path = (f"/tournaments/{tid}/standings?next_token={urllib.parse.quote(tok)}"
                if tok else f"/tournaments/{tid}/standings")
        d, err = _get(client, base, path, team_code)
        if err:
            meta["incomplete"] = True
            return all_items, err, meta
        all_items += (d or {}).get("items", []) or []
        page += 1
        meta["pages"] = page
        if (d or {}).get("total_teams") is not None:
            meta["total_teams"] = (d or {}).get("total_teams")
        tok = (d or {}).get("next_token")
        if not tok or page >= max_pages:
            break
    meta["incomplete"] = bool(tok)
    return all_items, None, meta
