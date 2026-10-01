"""server/replay_timeline.py — Unity 回放二进制 → 播放时间轴

回放源文件：`server/data/replays/<vendor_match_id>.msgpack.gz`
（= `gzip(msgpack)`，由 `routers/unity.py` 从 relay 下载后缓存）。

二进制结构（已解码，见 .workbuddy/memory/MEMORY.md §10）：

    list(5) = [
      vid,
      meta(36)  — [0]home 名 [1]away 名 … [8]=120(比赛秒) …
      frames(N) — 每帧 10 字段：
                  [0] 帧号
                  [1] gameTime  (比赛钟，秒)
                  [2] playMode
                  [3] null
                  [4] [scoreHome, scoreAway]
                  [5] ball(7)
                  [6] players(10 × ~15)   ← 真·10 人坐标
                  [7] null
                  [8] phase
                  [9] phase 配置倒计时
      result(6) — [vid, [scoreH,scoreA], homeStats, awayStats, None, goals(15)]
      events(N) — [playerId, timeVal, 'phase'|'goal', …]
    ]

## 为什么需要它

回放**不是** gameTime 驱动的线性播放：进球庆祝 / 开球等待 / 赛前序列这些段落里
「墙钟在走，gameTime 冻结」（全片约 70% 的帧 dt(gameTime) == 0）。
因此同步轴必须是**帧序号**（≈ 墙钟 × fps），而不是 gameTime。

实测（59c9cce2）：phase 5 段恒 ~151 帧 ↔ 3.0s 倒计时 ⇒ fps ≈ 50；全片 19686 帧 ≈ 391s。

## 输出

build_timeline() 返回紧凑的播放时间轴（几 KB，可 JSON 缓存）：

    {
      fps, total_frames, duration_sec,
      segments: [{f0, f1, phase, cd, gt0, gt1, dt, clock}]   # 连续同 phase 段
    }

clock=True 的段里 gameTime 每帧 +dt（≈0.02）；clock=False 的段是动画/等待。
"""

import gzip
import json
import os
import struct

# ---------------------------------------------------------------- msgpack 解码

try:  # 有 C 扩展就用它（快 10×+），否则走下面的纯 Python 最小实现
    import msgpack as _msgpack  # type: ignore
except Exception:  # noqa: BLE001
    _msgpack = None


def _unpack_pure(buf):
    """msgpack 最小解码器（覆盖本数据用到的全部类型 + 常规类型）。

    不引入第三方依赖，保证 start.sh / start.bat 任何一条启动路径都能跑。
    """
    pos = 0
    unpack_from = struct.unpack_from

    def rd(n):
        nonlocal pos
        v = buf[pos:pos + n]
        pos += n
        return v

    def rd_str(n):
        return rd(n).decode("utf-8", "replace")

    def read():
        nonlocal pos
        b = buf[pos]
        pos += 1
        if b <= 0x7F:                                   # positive fixint
            return b
        if b >= 0xE0:                                   # negative fixint
            return b - 256
        if 0x80 <= b <= 0x8F:                           # fixmap
            return {read(): read() for _ in range(b & 0x0F)}
        if 0x90 <= b <= 0x9F:                           # fixarray
            return [read() for _ in range(b & 0x0F)]
        if 0xA0 <= b <= 0xBF:                           # fixstr
            return rd_str(b & 0x1F)
        if b == 0xC0:
            return None
        if b == 0xC2:
            return False
        if b == 0xC3:
            return True
        if b == 0xC4:
            n = buf[pos]; pos += 1
            return rd(n)
        if b == 0xC5:
            return rd(unpack_from(">H", buf, pos)[0])
        if b == 0xC6:
            return rd(unpack_from(">I", buf, pos)[0])
        if b == 0xCA:
            v = unpack_from(">f", buf, pos)[0]; pos += 4; return v
        if b == 0xCB:
            v = unpack_from(">d", buf, pos)[0]; pos += 8; return v
        if b == 0xCC:
            v = buf[pos]; pos += 1; return v
        if b == 0xCD:
            v = unpack_from(">H", buf, pos)[0]; pos += 2; return v
        if b == 0xCE:
            v = unpack_from(">I", buf, pos)[0]; pos += 4; return v
        if b == 0xCF:
            v = unpack_from(">Q", buf, pos)[0]; pos += 8; return v
        if b == 0xD0:
            v = unpack_from(">b", buf, pos)[0]; pos += 1; return v
        if b == 0xD1:
            v = unpack_from(">h", buf, pos)[0]; pos += 2; return v
        if b == 0xD2:
            v = unpack_from(">i", buf, pos)[0]; pos += 4; return v
        if b == 0xD3:
            v = unpack_from(">q", buf, pos)[0]; pos += 8; return v
        if 0xD4 <= b <= 0xD8:                           # fixext 1/2/4/8/16
            n = 1 << (b - 0xD4)
            pos += 1
            return rd(n)
        if b == 0xD9:
            n = buf[pos]; pos += 1
            return rd_str(n)
        if b == 0xDA:
            n = unpack_from(">H", buf, pos)[0]; pos += 2
            return rd_str(n)
        if b == 0xDB:
            n = unpack_from(">I", buf, pos)[0]; pos += 4
            return rd_str(n)
        if b == 0xDC:
            n = unpack_from(">H", buf, pos)[0]; pos += 2
            return [read() for _ in range(n)]
        if b == 0xDD:
            n = unpack_from(">I", buf, pos)[0]; pos += 4
            return [read() for _ in range(n)]
        if b == 0xDE:
            n = unpack_from(">H", buf, pos)[0]; pos += 2
            return {read(): read() for _ in range(n)}
        if b == 0xDF:
            n = unpack_from(">I", buf, pos)[0]; pos += 4
            return {read(): read() for _ in range(n)}
        if 0xC7 <= b <= 0xC9:                           # ext 8/16/32
            w = {0xC7: 1, 0xC8: 2, 0xC9: 4}[b]
            n = unpack_from({1: ">B", 2: ">H", 4: ">I"}[w], buf, pos)[0]
            pos += w + 1
            return rd(n)
        raise ValueError("unsupported msgpack byte 0x%02x @%d" % (b, pos - 1))

    return read()


def decode_replay_gz(path):
    """解 gzip(msgpack) → python 对象。"""
    with gzip.open(path, "rb") as f:
        raw = f.read()
    if _msgpack is not None:
        return _msgpack.unpackb(raw, raw=False, strict_map_key=False)
    return _unpack_pure(raw)


# ---------------------------------------------------------------- 时间轴构建

# 缓存格式版本：结构变化时 +1，旧缓存自动失效重算
# v5: goals 改用「比分跳变帧」+ 新增 kickoff_frame（仪式结束、正式开球的帧号）
TIMELINE_VERSION = 5


def build_timeline(gz_path):
    """把回放二进制解成紧凑播放时间轴。"""
    obj = decode_replay_gz(gz_path)
    frames = obj[2]
    n = len(frames)
    if not n:
        raise ValueError("回放帧数为 0")

    def num(x):
        return x if isinstance(x, (int, float)) else None

    # 切段：phase 变化 **或** 比赛钟启停。
    # 注意 phase 7 内部同时存在「跑」与「冻结」两种帧（进球发生在 phase 切换之前），
    # 所以不能只按 phase 切，否则段的 dt 会被摊平算错。
    def gt_at(i):
        return num(frames[i][1])

    def advancing(i):
        a, b = gt_at(i - 1), gt_at(i)
        return a is not None and b is not None and b > a + 1e-9

    segs = []
    f0 = 0
    cur_phase = frames[0][8]
    cur_cd = num(frames[0][9])
    cur_adv = advancing(1) if n > 1 else False
    for i in range(1, n + 1):
        if i < n:
            adv = advancing(i)
            if frames[i][8] == cur_phase and adv == cur_adv:
                continue
        seg = frames[f0:i]
        gt0, gt1 = num(seg[0][1]), num(seg[-1][1])
        clock = bool(cur_adv and gt0 is not None and gt1 is not None and gt1 > gt0 + 1e-9)
        dt = (gt1 - gt0) / (len(seg) - 1) if (clock and len(seg) > 1) else 0.02
        segs.append({
            "f0": f0,
            "f1": i - 1,
            "phase": cur_phase,
            "cd": cur_cd,
            "gt0": gt0,
            "gt1": gt1,
            "dt": round(dt, 6),
            "clock": clock,
        })
        if i < n:
            f0, cur_phase, cur_cd = i, frames[i][8], num(frames[i][9])
            cur_adv = advancing(i) if i < n else False

    # fps：用「有倒计时的段」反推（帧数 / 倒计时秒数），取中位数
    est = []
    for s in segs:
        if s["cd"] and s["cd"] > 0 and not s["clock"]:
            est.append((s["f1"] - s["f0"] + 1) / float(s["cd"]))
    if not est:
        for s in segs:
            if s["cd"] and s["cd"] > 0:
                est.append((s["f1"] - s["f0"] + 1) / float(s["cd"]))
    if est:
        est.sort()
        fps = est[len(est) // 2]
    else:
        fps = 50.0

    # ⭐ 恒等式：回放是「一帧 = 一个引擎 tick」的 1:1 录制 ⇒ 帧号 == gameState.tick。
    # 实测两场 116/116、165/165 零误差。成立时 tick → 帧号 可直接取等，
    # 比按 gameTime 反查更准（冻结段里的 tick 不会被折叠掉）。
    tick_indexed = all(int(frames[i][0]) == i for i in range(n))

    # 进球帧：**优先用「比分跳变帧」**——它是权威的。
    # 实测（59c9cce2）比分跳变 15 次，与 meta[3][5] 的 15 条进球记录逐一对应，
    # 且两侧累计比分完全吻合（1-0/2-0/2-1/…/10-5）。比按 gameTime 反查更准：
    # 后者落在「跑→冻结」的段边界上，会差 1 帧，且冻结段内帧号有歧义。
    score_events = []
    ph = pa = 0
    for i in range(n):
        s = frames[i][4]
        if not isinstance(s, (list, tuple)) or len(s) < 2:
            continue
        try:
            h, a = int(s[0]), int(s[1])
        except Exception:  # noqa: BLE001
            continue
        if (h, a) != (ph, pa):
            score_events.append({
                "f": i,
                "h": h,
                "a": a,
                "gt": round(num(frames[i][1]) or 0.0, 3),
            })
            ph, pa = h, a

    raw_goals = []
    try:
        raw_goals = obj[3][5] or []
    except Exception:  # noqa: BLE001
        raw_goals = []

    goals = []
    if score_events and len(score_events) == len(raw_goals):
        # 两个独立来源条数一致 ⇒ 采用逐帧精确的比分跳变帧
        p_h = p_a = 0
        for ev in score_events:
            goals.append({
                "f": ev["f"],
                "s": 0 if ev["h"] > p_h else 1,   # 侧别由比分增量决定
                "gt": ev["gt"],
            })
            p_h, p_a = ev["h"], ev["a"]
    else:
        # 回退：按 gameTime 反查帧号（条数不一致时仍能给出近似位置）
        gi = 0
        for item in raw_goals:
            try:
                side_raw, g = item[0], float(item[2])
            except Exception:  # noqa: BLE001
                continue
            while gi < n and (gt_at(gi) is None or gt_at(gi) < g - 1e-6):
                gi += 1
            f = gi if gi < n else n - 1
            goals.append({
                "f": f,
                "s": 1 if str(side_raw).lower().startswith("away") else 0,
                "gt": round(g, 3),
            })

    # 累计比分 + 每次进球之后的「开球等待」段 —— 让前端能把客户端日志
    #   [ReplayClientBootstrap] GOAL detected: Home 2-0        → 精确定位进球帧
    #   [ReplayClientBootstrap] Phase: FIRST_HALF → COUNTDOWN_TO_KICKOFF → 等待段起点
    #   [ReplayClientBootstrap] Phase: COUNTDOWN_TO_KICKOFF → FIRST_HALF → 恢复比赛帧
    # 逐条映射回帧号，实现**整场持续重锚定**（漂移不可能累积）。
    hs = aw = 0
    for g in goals:
        if g["s"] == 0:
            hs += 1
        else:
            aw += 1
        g["h"] = hs
        g["a"] = aw
        w0 = w1 = None
        for s in segs:
            if s["phase"] == 5 and s["f0"] >= g["f"]:
                w0, w1 = s["f0"], s["f1"] + 1
                break
        g["w0"] = w0
        g["w1"] = w1

    # 开球帧 = 第一个「比赛钟在走」的段起点。
    # 实测与客户端自报的 `[ReplayClientBootstrap] Ceremony complete. Gameplay starts
    # at frame N` 完全一致（59c9cce2: 3088）。前端用它把「画面切成球场」这一
    # 视觉时刻钉成精确帧号 —— 这是不依赖客户端日志的兜底锚点。
    run_segs = [s for s in segs if s["clock"]]
    kickoff_frame = run_segs[0]["f0"] if run_segs else None

    return {
        "v": TIMELINE_VERSION,
        "fps": round(fps, 3),
        "total_frames": n,
        "duration_sec": round(n / fps, 2),
        "segments": segs,
        "phases": sorted({s["phase"] for s in segs if s["phase"] is not None}),
        "tick_indexed": tick_indexed,
        "goals": goals,
        "kickoff_frame": kickoff_frame,
    }


def frame_for_tick(timeline, t, game_time=None):
    """gameState.tick → 播放帧号。

    tick_indexed 为真时①帧号 == tick（实测成立）；否则退化为按 gameTime 反查。
    """
    if timeline.get("tick_indexed") and isinstance(t, int) and 0 <= t < timeline["total_frames"]:
        return t
    return frame_for_game_time(timeline, game_time)


def frame_for_game_time(timeline, g):
    """比赛钟 gameTime(秒) → 播放帧号。

    只在 clock=True 的段里线性映射（该段 gameTime 每帧 +dt≈0.02）。
    g 落在冻结间隙 / 范围外时，钳制到最近的可播帧。
    """
    if g is None:
        return 0
    segs = [s for s in timeline.get("segments") or []
            if s.get("clock") and s.get("gt0") is not None and s.get("gt1") is not None]
    if not segs:
        return 0
    first, last = segs[0], segs[-1]
    if g <= first["gt0"]:
        return first["f0"]
    if g >= last["gt1"]:
        return last["f1"]
    for s in segs:
        if s["gt0"] - 1e-6 <= g <= s["gt1"] + 1e-6:
            dt = s.get("dt") or 0.02
            fr = s["f0"] + (g - s["gt0"]) / dt
            return int(max(s["f0"], min(s["f1"], round(fr))))
    prev = None
    for s in segs:
        if s["gt0"] > g:
            break
        prev = s
    return prev["f1"] if prev else first["f0"]


# ---------------------------------------------------------------- 缓存读写

def timeline_path(replays_dir, vendor_match_id):
    safe = vendor_match_id.replace("/", "_").replace("\\", "_")
    return os.path.join(replays_dir, f"{safe}.timeline.json")


def timeline_reason(replays_dir, vendor_match_id):
    """ensure_timeline 返回 None 时给出可读原因，供前端区分提示。"""
    safe = vendor_match_id.replace("/", "_").replace("\\", "_")
    gz = os.path.join(replays_dir, f"{safe}.msgpack.gz")
    if not os.path.exists(gz):
        # 正常不是错误：首播前二进制还没被 /unity/replays 拉下来缓存
        return "missing_replay_binary"
    return "decode_failed"


def ensure_timeline(replays_dir, vendor_match_id):
    """读缓存；缺失则从 .msgpack.gz 现算并落盘。失败返回 None（不阻断主流程）。"""
    gz = os.path.join(replays_dir, f"{vendor_match_id.replace('/', '_')}.msgpack.gz")
    if not os.path.exists(gz):
        return None
    tp = timeline_path(replays_dir, vendor_match_id)
    if os.path.exists(tp):
        try:
            with open(tp, encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("v") == TIMELINE_VERSION:
                return cached
        except Exception:  # noqa: BLE001
            pass  # 缓存损坏 → 重算
    try:
        tl = build_timeline(gz)
    except Exception:  # noqa: BLE001
        return None
    try:
        tmp = tp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(tl, f, ensure_ascii=False)
        os.replace(tmp, tp)
    except Exception:  # noqa: BLE001
        pass
    return tl
