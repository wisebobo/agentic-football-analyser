"""
server/db.py — SQLite 数据层（新库 server/data/agentic_football.db）
表：tournaments / matches / goals / command_breakdown / agent_stats /
    tick_prompts / leaderboard_rows / fetch_runs
"""
import os
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "agentic_football.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tournaments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_code       TEXT NOT NULL UNIQUE,
    tournament_id   TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    team_name       TEXT NOT NULL,
    tournament_name TEXT,
    detail_json     TEXT,
    base_url        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    auto_enabled    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
    match_id             TEXT PRIMARY KEY,
    tournament_id        TEXT NOT NULL,
    team_id              TEXT,
    our_side             TEXT,
    home_team_name       TEXT,
    away_team_name       TEXT,
    home_team_id         TEXT,
    away_team_id         TEXT,
    home_score           INTEGER,
    away_score           INTEGER,
    status               TEXT,
    match_duration_seconds INTEGER,
    mvp_agent_position   TEXT,
    mvp_agent_name       TEXT,
    mvp_team_id          TEXT,
    report_available     INTEGER,
    home_possession_pct  REAL,
    away_possession_pct  REAL,
    home_shots           INTEGER,
    home_shots_on_target INTEGER,
    away_shots           INTEGER,
    away_shots_on_target INTEGER,
    is_practice          INTEGER,
    starting_at          TEXT,
    detail_json          TEXT,
    fetched_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_t ON matches(tournament_id);

CREATE TABLE IF NOT EXISTS goals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id     TEXT,
    team         TEXT,
    position     TEXT,
    agent_name   TEXT,
    game_time_secs REAL
);

CREATE TABLE IF NOT EXISTS command_breakdown (
    match_id TEXT,
    team     TEXT,
    command  TEXT,
    count    INTEGER,
    PRIMARY KEY (match_id, team, command)
);

CREATE TABLE IF NOT EXISTS agent_stats (
    match_id       TEXT,
    team           TEXT,
    position       TEXT,
    latency_avg_ms INTEGER,
    success_rate   REAL
);

CREATE TABLE IF NOT EXISTS tick_prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      TEXT,
    command_id    TEXT,
    side          INTEGER,
    command_type  TEXT,
    success       INTEGER,
    response_time INTEGER,
    prompt_json   TEXT,
    result_json   TEXT
);

CREATE TABLE IF NOT EXISTS leaderboard_rows (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id   TEXT NOT NULL,
    rank            INTEGER,
    team_id         TEXT,
    team_name       TEXT,
    coach_name      TEXT,
    matches_played  INTEGER,
    wins            INTEGER,
    draws           INTEGER,
    losses          INTEGER,
    goals_scored    INTEGER,
    goals_conceded  INTEGER,
    goal_difference INTEGER,
    points          INTEGER,
    icon_url        TEXT,
    fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lb_t ON leaderboard_rows(tournament_id, fetched_at);

CREATE TABLE IF NOT EXISTS fetch_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id    TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT,
    matches_seen     INTEGER,
    new_matches      INTEGER,
    refreshed        INTEGER,
    skipped          INTEGER,
    failed           INTEGER,
    leaderboard_rows INTEGER,
    incomplete       INTEGER,
    error_text       TEXT
);
"""


def get_conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript(SCHEMA)
    # 迁移：为已有 DB 补加 is_practice / starting_at 列
    _migrate_add_columns(conn)
    # 迁移：为已有 DB 的 tournaments 表补加 auto_enabled 列
    _migrate_tournaments(conn)
    conn.commit()
    conn.close()


def _migrate_add_columns(conn: sqlite3.Connection) -> None:
    """为旧库补充新列并回填。"""
    cur = conn.cursor()
    # 检查列是否已存在
    cols = {r[1] for r in cur.execute("PRAGMA table_info(matches)").fetchall()}
    added = set()
    if "is_practice" not in cols:
        cur.execute("ALTER TABLE matches ADD COLUMN is_practice INTEGER")
        added.add("is_practice")
    if "starting_at" not in cols:
        cur.execute("ALTER TABLE matches ADD COLUMN starting_at TEXT")
        added.add("starting_at")
    if not added:
        return
    # 回填：从 detail_json 中提取（仅处理 null 的行）
    null_mask = " OR ".join(f"{c} IS NULL" for c in added)
    rows = cur.execute(
        f"SELECT match_id, detail_json FROM matches WHERE {null_mask}"
    ).fetchall()
    for row in rows:
        mid, dj = row["match_id"], row["detail_json"]
        if not dj:
            continue
        try:
            d = json.loads(dj)
        except Exception:
            continue
        updates: dict = {}
        if "is_practice" in added and d.get("is_practice") is not None:
            updates["is_practice"] = 1 if d["is_practice"] else 0
        if "starting_at" in added and d.get("startingAt"):
            updates["starting_at"] = d["startingAt"]
        if updates:
            set_clause = ", ".join(f"{k}=?" for k in updates)
            cur.execute(f"UPDATE matches SET {set_clause} WHERE match_id=?",
                        list(updates.values()) + [mid])


def _migrate_tournaments(conn: sqlite3.Connection) -> None:
    """为旧库的 tournaments 表补充 auto_enabled 列（默认 0，新赛事默认关）。"""
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(tournaments)").fetchall()}
    if "auto_enabled" not in cols:
        cur.execute("ALTER TABLE tournaments ADD COLUMN auto_enabled INTEGER NOT NULL DEFAULT 0")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- tournaments（不可变配置） ----------

def tournament_exists_code(team_code: str) -> bool:
    conn = get_conn()
    row = conn.execute("SELECT 1 FROM tournaments WHERE team_code=?", (team_code,)).fetchone()
    conn.close()
    return row is not None


def create_tournament(*, team_code, tournament_id, team_id, team_name,
                     tournament_name, detail_json, base_url) -> int:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO tournaments
           (team_code, tournament_id, team_id, team_name, tournament_name, detail_json, base_url, created_at, auto_enabled)
           VALUES (?,?,?,?,?,?,?,?,0)""",
        (team_code, tournament_id, team_id, team_name, tournament_name,
         detail_json, base_url, _now()),
    )
    conn.commit()
    tid = cur.lastrowid
    conn.close()
    return tid


def list_tournaments():
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, team_code, tournament_id, team_id, team_name,
                  tournament_name, base_url, created_at, auto_enabled
           FROM tournaments ORDER BY id""").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_auto_enabled(local_id: int, enabled: int) -> None:
    conn = get_conn()
    conn.execute("UPDATE tournaments SET auto_enabled=? WHERE id=?", (1 if enabled else 0, local_id))
    conn.commit()
    conn.close()


def get_tournament(local_id: int):
    conn = get_conn()
    row = conn.execute("SELECT * FROM tournaments WHERE id=?", (local_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    try:
        d["detail"] = json.loads(d["detail_json"]) if d.get("detail_json") else None
    except Exception:
        d["detail"] = None
    return d


# ---------- matches 写入 ----------

def match_status(match_id: str):
    conn = get_conn()
    row = conn.execute("SELECT status FROM matches WHERE match_id=?", (match_id,)).fetchone()
    conn.close()
    return row["status"] if row else None


def save_match(*, match_id, tournament_id, team_id, detail, prompts):
    """写入单场全部数据（幂等：重复拉取先清旧明细再重插）。"""
    conn = get_conn()
    c = conn.cursor()
    res = (detail or {}).get("result", {}) or {}
    gs = (detail or {}).get("game_stats", {}) or {}

    our_side = None
    if team_id:
        if (detail or {}).get("home_team_id") == team_id:
            our_side = "home"
        elif (detail or {}).get("away_team_id") == team_id:
            our_side = "away"

    c.execute(
        """INSERT OR REPLACE INTO matches (
             match_id, tournament_id, team_id, our_side,
             home_team_name, away_team_name, home_team_id, away_team_id,
             home_score, away_score, status, match_duration_seconds,
             mvp_agent_position, mvp_agent_name, mvp_team_id,
             report_available,
             home_possession_pct, away_possession_pct,
             home_shots, home_shots_on_target, away_shots, away_shots_on_target,
             is_practice, starting_at,
             detail_json, fetched_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            match_id, tournament_id, team_id, our_side,
            detail.get("home_team_name"), detail.get("away_team_name"),
            detail.get("home_team_id"), detail.get("away_team_id"),
            res.get("home_score"), res.get("away_score"),
            detail.get("status"), detail.get("match_duration_seconds"),
            detail.get("mvp_agent_position"), detail.get("mvp_agent_name"),
            detail.get("mvp_team_id"),
            1 if (detail or {}).get("report_available") else 0,
            (gs.get("home") or {}).get("possession_pct"),
            (gs.get("away") or {}).get("possession_pct"),
            (gs.get("home") or {}).get("shots"),
            (gs.get("home") or {}).get("shots_on_target"),
            (gs.get("away") or {}).get("shots"),
            (gs.get("away") or {}).get("shots_on_target"),
            1 if (detail or {}).get("is_practice") else 0,
            detail.get("startingAt"),
            json.dumps(detail, ensure_ascii=False) if detail else None,
            _now(),
        ),
    )
    for table in ("goals", "command_breakdown", "agent_stats", "tick_prompts"):
        c.execute(f"DELETE FROM {table} WHERE match_id=?", (match_id,))

    for g in gs.get("goals", []) or []:
        c.execute(
            "INSERT INTO goals (match_id, team, position, agent_name, game_time_secs) VALUES (?,?,?,?,?)",
            (match_id, g.get("team"), g.get("position"), g.get("agent_name"), g.get("game_time_secs")),
        )
    for side in ("home", "away"):
        for cmd, cnt in ((detail or {}).get(f"{side}_command_breakdown") or {}).items():
            c.execute(
                "INSERT OR REPLACE INTO command_breakdown (match_id, team, command, count) VALUES (?,?,?,?)",
                (match_id, side, cmd, cnt),
            )
        for pos, s in ((detail or {}).get(f"{side}_agent_stats") or {}).items():
            c.execute(
                "INSERT OR REPLACE INTO agent_stats (match_id, team, position, latency_avg_ms, success_rate) "
                "VALUES (?,?,?,?,?)",
                (match_id, side, str(pos), (s or {}).get("latency_avg_ms"), (s or {}).get("success_rate")),
            )
    for p in prompts or []:
        c.execute(
            """INSERT INTO tick_prompts
               (match_id, command_id, side, command_type, success, response_time, prompt_json, result_json)
               VALUES (?,?,?,?,?,?,?,?)""",
            (match_id, p.get("commandId"), p.get("teamId"), p.get("commandType"),
             1 if p.get("success") else 0, p.get("responseTime"),
             p.get("prompt") if isinstance(p.get("prompt"), str) else
             json.dumps(p.get("prompt"), ensure_ascii=False) if p.get("prompt") is not None else None,
             p.get("result") if isinstance(p.get("result"), str) else
             json.dumps(p.get("result"), ensure_ascii=False) if p.get("result") is not None else None),
        )
    conn.commit()
    conn.close()


# ---------- matches 读取 ----------

def list_matches_rows(tournament_id: str = None):
    conn = get_conn()
    if tournament_id:
        rows = conn.execute(
            """SELECT match_id, our_side, home_team_name, away_team_name,
                      home_score, away_score, status, match_duration_seconds,
                      mvp_agent_name, report_available, is_practice, starting_at, fetched_at
               FROM matches WHERE tournament_id=? ORDER BY fetched_at DESC""",
            (tournament_id,)).fetchall()
    else:
        rows = conn.execute(
            """SELECT match_id, our_side, home_team_name, away_team_name,
                      home_score, away_score, status, match_duration_seconds,
                      mvp_agent_name, report_available, is_practice, starting_at,
                      tournament_id, fetched_at
               FROM matches ORDER BY fetched_at DESC""").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_match_full(match_id: str):
    conn = get_conn()
    c = conn.cursor()
    m = c.execute("SELECT * FROM matches WHERE match_id=?", (match_id,)).fetchone()
    if not m:
        conn.close()
        return None
    out = dict(m)
    out["goals"] = [dict(r) for r in c.execute(
        "SELECT team, position, agent_name, game_time_secs FROM goals WHERE match_id=? ORDER BY game_time_secs",
        (match_id,)).fetchall()]
    out["command_breakdown"] = {
        "home": {r["command"]: r["count"] for r in c.execute(
            "SELECT command, count FROM command_breakdown WHERE match_id=? AND team='home'", (match_id,)).fetchall()},
        "away": {r["command"]: r["count"] for r in c.execute(
            "SELECT command, count FROM command_breakdown WHERE match_id=? AND team='away'", (match_id,)).fetchall()},
    }
    out["agent_stats"] = [dict(r) for r in c.execute(
        "SELECT team, position, latency_avg_ms, success_rate FROM agent_stats WHERE match_id=? ORDER BY team, position",
        (match_id,)).fetchall()]
    ticks = c.execute(
        "SELECT command_type, response_time, success FROM tick_prompts WHERE match_id=?", (match_id,)).fetchall()
    out["tick_count"] = len(ticks)
    out["ticks"] = [{"command_type": r["command_type"], "response_time": r["response_time"], "success": r["success"]}
                    for r in ticks]
    conn.close()
    return out


# ---------- replay（移植自旧 webapp/db.py get_replay） ----------

def _safe_json(s):
    if s is None:
        return None
    if isinstance(s, (dict, list)):
        return s
    try:
        return json.loads(s)
    except Exception:
        return None


def _num(v):
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _extract_gs(gs):
    """从 tick 的 prompt_json 提取球坐标 / 比分 / 持球者。"""
    ball = score = poss = None
    players_available = False
    if not isinstance(gs, dict):
        return ball, score, poss, players_available
    inner = gs.get("gameState") if isinstance(gs.get("gameState"), dict) else gs
    braw = inner.get("ball")
    if isinstance(braw, dict):
        pos = braw.get("position") if isinstance(braw.get("position"), dict) else braw
        bx, bz = _num(pos.get("x")), _num(pos.get("z"))
        if bx is not None and bz is not None:
            ball = {"x": bx, "z": bz}
        poss = braw.get("possessionAgentId")
    sc = inner.get("score") if isinstance(inner.get("score"), dict) else None
    if isinstance(sc, dict):
        score = {"home": _num(sc.get("home")), "away": _num(sc.get("away"))}
    plist = inner.get("players")
    players_available = isinstance(plist, list) and len(plist) > 0
    return ball, score, poss, players_available


def _clean_params(p):
    """parameters → 仅保留 JSON 基础类型（前端直接渲染，不丢字段）。空则 None。"""
    if not isinstance(p, dict):
        return None
    out = {}
    for k, v in p.items():
        if v is None or isinstance(v, (bool, int, float, str)):
            out[str(k)] = v
    return out or None


def _extract_cmds(res):
    """该 tick 五人指令集 → 紧凑列表。

    除几何用的 tx/ty/sprint 外，**原样透出 `parameters` 与 `duration`**：
    实测 9 类命令全部带参（`tick_prompts.result_json` 全库 7940 条指令统计）——
      MOVE_TO       target_x / target_y / sprint
      PRESS_BALL    intensity            （0.4~1）
      SHOOT         aim_location / power （CENTER 92% / 力度 1 占 76%）
      INTERCEPT     aggressive
      FOLLOW_PLAYER target_player_id / target_team / distance
      MARK          target_player_id / tightness
      PASS          target_player_id / type（GROUND|AERIAL|THROUGH）
      GK_DISTRIBUTE target_player_id / method（KICK|THROW）
      CLEAR_OVERRIDE 无参
    只挑 tx/ty 会让 SHOOT/FOLLOW_PLAYER/MARK… 全部显示成「—」。
    """
    if not isinstance(res, list):
        return []
    out = []
    for c in res:
        if not isinstance(c, dict):
            continue
        par = c.get("parameters") if isinstance(c.get("parameters"), dict) else {}
        tx = _num(c.get("target_x")) if _num(c.get("target_x")) is not None else _num(par.get("target_x"))
        ty = _num(c.get("target_y")) if _num(c.get("target_y")) is not None else _num(par.get("target_y"))
        sprint = c.get("sprint", par.get("sprint"))
        dur = _num(c.get("duration"))
        out.append({
            "pid": c.get("playerId", c.get("id")),
            "team": c.get("teamId", c.get("team")),
            "cmd": c.get("command", c.get("commandType")),
            "tx": tx, "ty": ty,
            "sprint": 1 if sprint else 0,
            # 完整参数（前端按命令语义排版）
            "params": _clean_params(par),
            # duration 逐命令：0=一次性 / >0=持续 N 秒 / -1=持续到被覆盖（非恒定值）
            "duration": dur,
        })
    return out


def get_replay(match_id: str):
    """按真实 gameState.tick 顺序返回紧凑重播数据（逐行注释逻辑同旧实现）。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT command_id, side, command_type, success, response_time, prompt_json, result_json "
        "FROM tick_prompts WHERE match_id=? ORDER BY id", (match_id,)
    ).fetchall()
    m = conn.execute(
        "SELECT our_side, home_team_name, away_team_name FROM matches WHERE match_id=?", (match_id,)
    ).fetchone()
    conn.close()
    our_side = m["our_side"] if m else None
    home_name = m["home_team_name"] if m else None
    away_name = m["away_team_name"] if m else None

    parsed = []
    for r in rows:
        gs = _safe_json(r["prompt_json"])
        res = _safe_json(r["result_json"])
        ball, score, poss, pa = _extract_gs(gs) if gs else (None, None, None, False)
        inner = (gs.get("gameState") if isinstance(gs, dict) and isinstance(gs.get("gameState"), dict)
                 else (gs if isinstance(gs, dict) else {}))
        t = inner.get("tick")
        t = t if isinstance(t, (int, float)) else None
        cmds = _extract_cmds(res)
        parsed.append({
            "side": r["side"], "t": t,
            "gameTime": _num(inner.get("gameTime")),
            "playMode": inner.get("playMode"),
            "score": score, "ball": ball, "poss": poss,
            "cmds": cmds, "players_available": pa,
            "_has_ball": ball is not None,
            "_ncmd": len(cmds) if isinstance(cmds, list) else 0,
        })

    # 同 tick 多 side 合并为单帧；指令目标沿 tick 累积（状态保持）。
    groups = defaultdict(list)
    for p in parsed:
        groups[p["t"]].append(p)
    last_xy = {}

    def _upd_last(cmds):
        for c in cmds:
            team = c.get("team")
            pid = c.get("pid")
            if team is None or pid is None:
                continue
            if c.get("tx") is not None and c.get("ty") is not None:
                last_xy[(team, pid)] = (c["tx"], c["ty"])

    ticks = []
    for t in sorted(groups.keys(), key=lambda x: (x is None, x if x is not None else 1 << 62)):
        grp = groups[t]
        by_side = defaultdict(list)
        for p in grp:
            by_side[p["side"]].append(p)
        chosen = []
        for side, lst in by_side.items():
            rep = sorted(lst, key=lambda x: (not x["_has_ball"], -x["_ncmd"]))[0]
            chosen.append(rep)
        ball_rep = next((c for c in chosen if c["ball"]), None)
        # agent 小尺度球坐标 → 世界尺度（±55/±35）
        ball = ball_rep["ball"] if ball_rep else None
        if ball:
            ball = {"x": ball["x"] * 55.0 / 7.0, "z": ball["z"] * 55.0 / 7.0}
        poss = ball_rep["poss"] if ball_rep else None
        score = next((c["score"] for c in chosen if c["score"]), None)
        gameTime = next((c["gameTime"] for c in chosen if c["gameTime"] is not None), None)
        playMode = next((c["playMode"] for c in chosen if c["playMode"]), None)
        cmds = []
        for c in chosen:
            cmds.extend(c["cmds"])
        _upd_last(cmds)
        # 持球者钉到球上，形成连续带球轨迹
        if ball_rep is not None and poss and ball_rep["side"] in (0, 1):
            _pid_s = str(poss).rsplit("_", 1)[-1]
            if _pid_s.isdigit():
                _ppid = int(_pid_s)
                if 0 <= _ppid < 5:
                    last_xy[(ball_rep["side"], _ppid)] = (ball["x"], ball["z"])
        players = []
        for team in (0, 1):
            for pid in range(5):
                key = (team, pid)
                x, y = last_xy.get(key, (0.0, 0.0))
                players.append({"pid": pid, "team": team, "x": x, "y": y, "tx": x, "ty": y})
        sides_present = sorted(set(c["side"] for c in chosen if c["side"] is not None))
        our_team = 0 if our_side == "home" else (1 if our_side == "away" else None)
        ticks.append({
            "t": t, "gameTime": gameTime, "playMode": playMode,
            "score": score, "ball": ball, "poss": poss,
            "poss_team": ball_rep["side"] if ball_rep else None,
            "cmds": cmds, "players": players,
            "sides_present": sides_present, "our_team": our_team,
        })

    for i, tk in enumerate(ticks):
        tk["i"] = i

    has_ball = any(tk["ball"] for tk in ticks)
    players_available = any(tk.get("players_available") for tk in ticks)
    warnings = []
    if rows and not has_ball:
        sample = _safe_json(rows[0]["prompt_json"]) or {}
        keys = list(sample.keys()) if isinstance(sample, dict) else []
        warnings.append("未从 gameState 解析出球坐标；顶层键=" + ",".join(keys[:12]))
    return {
        "tick_count": len(ticks),
        "available": has_ball,
        "player_positions_available": players_available,
        "warnings": warnings,
        "our_side": our_side,
        "home_name": home_name,
        "away_name": away_name,
        "ticks": ticks,
    }


# ---------- 跨场统计（可按赛事过滤） ----------

def get_stats(tournament_id: str = None):
    conn = get_conn()
    c = conn.cursor()
    if tournament_id:
        matches = c.execute("SELECT * FROM matches WHERE tournament_id=? ORDER BY COALESCE(starting_at, fetched_at) DESC", (tournament_id,)).fetchall()
    else:
        matches = c.execute("SELECT * FROM matches ORDER BY COALESCE(starting_at, fetched_at) DESC").fetchall()
    rows = [dict(m) for m in matches]
    conn.close()

    total = len(rows)
    known = [m for m in rows if m.get("our_side")]
    wins = losses = draws = 0
    for m in known:
        hs, as_ = m["home_score"] or 0, m["away_score"] or 0
        we, op = (hs, as_) if m["our_side"] == "home" else (as_, hs)
        if we > op:
            wins += 1
        elif we < op:
            losses += 1
        else:
            draws += 1

    conn = get_conn()
    if tournament_id:
        mids = [m["match_id"] for m in rows]
        if mids:
            qmarks = ",".join("?" * len(mids))
            cb_home = conn.execute(
                f"SELECT command, SUM(count) AS s FROM command_breakdown "
                f"WHERE team='home' AND match_id IN ({qmarks}) GROUP BY command", mids).fetchall()
            cb_away = conn.execute(
                f"SELECT command, SUM(count) AS s FROM command_breakdown "
                f"WHERE team='away' AND match_id IN ({qmarks}) GROUP BY command", mids).fetchall()
            ast = conn.execute(
                f"SELECT team, position, AVG(latency_avg_ms) AS l, AVG(success_rate) AS s FROM agent_stats "
                f"WHERE match_id IN ({qmarks}) GROUP BY team, position", mids).fetchall()
        else:
            cb_home = cb_away = ast = []
    else:
        cb_home = conn.execute(
            "SELECT command, SUM(count) AS s FROM command_breakdown WHERE team='home' GROUP BY command").fetchall()
        cb_away = conn.execute(
            "SELECT command, SUM(count) AS s FROM command_breakdown WHERE team='away' GROUP BY command").fetchall()
        ast = conn.execute(
            "SELECT team, position, AVG(latency_avg_ms) AS l, AVG(success_rate) AS s FROM agent_stats GROUP BY team, position").fetchall()
    conn.close()

    cb = {
        "home": {r["command"]: r["s"] for r in cb_home},
        "away": {r["command"]: r["s"] for r in cb_away},
    }
    agent_agg = {}
    for r in ast:
        agent_agg.setdefault(r["team"], {})[r["position"]] = {
            "latency": round(r["l"] or 0), "success": round(r["s"] or 0, 3)}

    def _avg(col):
        vals = [m[col] for m in rows if m.get(col) is not None]
        return round(sum(vals) / len(vals), 1) if vals else 0

    def _sum(col):
        return sum((m.get(col) or 0) for m in rows)

    possession = {"home": _avg("home_possession_pct"), "away": _avg("away_possession_pct")}
    shots = {
        "home": {"shots": _sum("home_shots"), "sot": _sum("home_shots_on_target")},
        "away": {"shots": _sum("away_shots"), "sot": _sum("away_shots_on_target")},
    }

    series = []
    for m in rows:
        hs, as_ = m["home_score"] or 0, m["away_score"] or 0
        we, op = (hs, as_) if m.get("our_side") == "home" else (as_, hs) if m.get("our_side") else (None, None)
        series.append({
            "match_id": m["match_id"],
            "home": m["home_team_name"], "away": m["away_team_name"],
            "home_score": hs, "away_score": as_,
            "we": we, "op": op, "our_side": m.get("our_side"),
        })

    return {
        "total": total,
        "known_side": len(known),
        "wins": wins, "losses": losses, "draws": draws,
        "command_breakdown": cb,
        "agent_agg": agent_agg,
        "possession": possession,
        "shots": shots,
        "series": series,
        "matches": [{
            "match_id": m["match_id"], "home": m["home_team_name"], "away": m["away_team_name"],
            "home_score": m["home_score"], "away_score": m["away_score"],
            "our_side": m["our_side"], "status": m.get("status"),
            "is_practice": m.get("is_practice"),
            "starting_at": m.get("starting_at"),
            "duration": m["match_duration_seconds"],
        } for m in rows],
    }


# ---------- leaderboard 快照 ----------

def save_leaderboard_snapshot(tournament_id: str, items) -> int:
    """全量替换该赛事的积分榜快照，返回行数。"""
    conn = get_conn()
    c = conn.cursor()
    c.execute("DELETE FROM leaderboard_rows WHERE tournament_id=?", (tournament_id,))
    now = _now()
    n = 0
    for i, it in enumerate(items or []):
        c.execute(
            """INSERT INTO leaderboard_rows
               (tournament_id, rank, team_id, team_name, coach_name,
                matches_played, wins, draws, losses,
                goals_scored, goals_conceded, goal_difference, points, icon_url, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (tournament_id, it.get("rank") if it.get("rank") is not None else i + 1,
             it.get("team_id"), it.get("team_name") or it.get("name"),
             it.get("coach_name"),
             it.get("matches_played"), it.get("wins"), it.get("draws"), it.get("losses"),
             it.get("goals_scored"), it.get("goals_conceded"), it.get("goal_difference"),
             it.get("points"), it.get("icon_url"), now),
        )
        n += 1
    conn.commit()
    conn.close()
    return n


def get_leaderboard_snapshot(tournament_id: str):
    """该赛事最新快照（fetched_at 最大的一次拉取）。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT MAX(fetched_at) AS f FROM leaderboard_rows WHERE tournament_id=?", (tournament_id,)).fetchone()
    conn.close()
    if not row or not row["f"]:
        return None
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM leaderboard_rows WHERE tournament_id=? AND fetched_at=? ORDER BY rank",
        (tournament_id, row["f"])).fetchall()
    conn.close()
    out = [dict(r) for r in rows]
    for r in out:
        r.pop("id", None)
    return {"fetched_at": row["f"], "rows": out}


# ---------- fetch_runs 日志 ----------

def fetch_run_start(tournament_id: str) -> int:
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO fetch_runs (tournament_id, started_at) VALUES (?,?)",
        (tournament_id, _now()))
    conn.commit()
    rid = cur.lastrowid
    conn.close()
    return rid


def fetch_run_finish(rid: int, *, matches_seen=0, new_matches=0, refreshed=0,
                     skipped=0, failed=0, leaderboard_rows=0,
                     incomplete=0, error_text=None):
    conn = get_conn()
    conn.execute(
        """UPDATE fetch_runs SET finished_at=?, matches_seen=?, new_matches=?, refreshed=?,
           skipped=?, failed=?, leaderboard_rows=?, incomplete=?, error_text=? WHERE id=?""",
        (_now(), matches_seen, new_matches, refreshed, skipped, failed,
         leaderboard_rows, 1 if incomplete else 0, error_text, rid),
    )
    conn.commit()
    conn.close()


def list_fetch_runs(tournament_id: str, limit: int = 20):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM fetch_runs WHERE tournament_id=? ORDER BY id DESC LIMIT ?",
        (tournament_id, limit)).fetchall()
    conn.close()
    return [dict(r) for r in rows]
