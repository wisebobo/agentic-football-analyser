import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ceremonyRemainSec, phaseNameZh, subscribeLifecycle } from "../unity/lifecycle";
import { playbackSnapshot, subscribePlayback } from "../unity/playback-watch";

export interface ReplayCmd {
  pid: number | null;
  team: number | null;
  cmd: string | null;
  tx: number | null;
  ty: number | null;
  sprint: number;
  /**
   * 命令完整参数，原样来自引擎 `result[].parameters`。
   * 实测 9 类命令全部带参，例如
   *   SHOOT         { aim_location: "CENTER", power: 1 }
   *   FOLLOW_PLAYER { target_player_id: 4, target_team: "HOME", distance: 2 }
   *   MARK          { target_player_id: 4, tightness: "LOOSE" }
   * 老数据可能没有该字段（后端加字段前落库的场次）。
   */
  params?: Record<string, unknown> | null;
  /** 0=一次性 / >0=持续 N 秒 / -1=持续到被覆盖（逐命令，非恒定值） */
  duration?: number | null;
}

/* ───────── 指令参数 → 可读摘要 ───────── */

/** 数值紧凑化：-0.6 / 2.5 / 55（最多两位小数，去掉浮点尾巴） */
export function fmtNum(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return String(Number(v.toFixed(2)));
}

const AIM_ZH: Record<string, string> = {
  CENTER: "中路",
  TL: "左上",
  TR: "右上",
  BL: "左下",
  BR: "右下",
};
const PASS_TYPE_ZH: Record<string, string> = {
  GROUND: "地面",
  AERIAL: "高球",
  THROUGH: "直塞",
};
const GK_METHOD_ZH: Record<string, string> = { KICK: "大脚开球", THROW: "手抛" };
const TIGHT_ZH: Record<string, string> = { LOOSE: "松", TIGHT: "紧" };
const TARGET_TEAM_ZH: Record<string, string> = { HOME: "主队", AWAY: "客队" };

/**
 * 单条指令的参数摘要（面板右列文本）。
 * 命令集与参数名逐字对齐引擎 emit 的 result[]，不做猜测；
 * 未收录的命令走通用 `k=v` 兜底，保证「有参数就一定显示出来」。
 */
export function cmdDetail(c: ReplayCmd): string {
  const p = (c.params ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : null);
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  const pname = (k = "target_player_id") => {
    const v = num(k);
    return v == null ? null : `P${fmtNum(v)}`;
  };
  const join = (parts: Array<string | null | undefined>) =>
    parts.filter((s): s is string => !!s).join(" · ");

  switch (c.cmd) {
    case "MOVE_TO": {
      const x = num("target_x") ?? c.tx;
      const y = num("target_y") ?? c.ty;
      return x == null || y == null ? "—" : `→ (${fmtNum(x)}, ${fmtNum(y)})`;
    }
    case "SHOOT": {
      const aim = str("aim_location");
      const pw = num("power");
      return (
        join([aim ? (AIM_ZH[aim] ?? aim) : null, pw != null ? `力度 ${fmtNum(pw)}` : null]) || "—"
      );
    }
    case "PASS": {
      const t = str("type");
      return join([pname(), t ? (PASS_TYPE_ZH[t] ?? t) : null]) || "—";
    }
    case "GK_DISTRIBUTE": {
      const m = str("method");
      return join([pname(), m ? (GK_METHOD_ZH[m] ?? m) : null]) || "—";
    }
    case "FOLLOW_PLAYER": {
      const tt = str("target_team");
      const d = num("distance");
      return (
        join([pname(), tt ? (TARGET_TEAM_ZH[tt] ?? tt) : null, d != null ? `${fmtNum(d)}m` : null]) ||
        "—"
      );
    }
    case "MARK": {
      const tg = str("tightness");
      return join([pname(), tg ? (TIGHT_ZH[tg] ?? tg) : null]) || "—";
    }
    case "PRESS_BALL": {
      const i = num("intensity");
      return i != null ? `强度 ${fmtNum(i)}` : "—";
    }
    case "INTERCEPT":
      return p.aggressive === true ? "激进" : p.aggressive === false ? "保守" : "—";
    case "CLEAR_OVERRIDE":
      return "解除覆盖";
    case "SET_STANCE":
    case "RESET":
      return "—";
    default: {
      // 兜底：把任何未收录命令的参数原样列出，不静默吞掉
      const kv = Object.entries(p).map(
        ([k, v]) => `${k}=${typeof v === "number" ? fmtNum(v) : String(v)}`,
      );
      return kv.length ? kv.join(" ") : "—";
    }
  }
}

/** duration 角标：0（一次性）不显示，>0 显示秒数，-1 表示持续到被覆盖 */
export function durLabel(d: number | null | undefined): string | null {
  if (typeof d !== "number" || d === 0) return null;
  return d < 0 ? "持续" : `${fmtNum(d)}s`;
}

/**
 * 是不是「打角落」的射门（aim_location ≠ CENTER）。
 * 全库 1016 次 SHOOT 里只有 8.3% 非中路，且**分布极不对称**：
 * teamId=0 恒 520/520 中路；非中路几乎全部来自 teamId=1。
 * ⇒ 这是 prompt 差异的强信号，UI 里必须一眼可见，不能被淹没在一堆「中路」里。
 */
export function isCornerShot(c: ReplayCmd): boolean {
  if (c.cmd !== "SHOOT") return false;
  const aim = (c.params as Record<string, unknown> | null | undefined)?.aim_location;
  return typeof aim === "string" && aim !== "CENTER";
}

export interface ReplayFrame {
  t: number | null;
  gameTime: number | null;
  playMode: string | null;
  score: { home: number | null; away: number | null } | null;
  ball: { x: number; z: number } | null;
  poss: unknown;
  poss_team: number | null;
  cmds: ReplayCmd[];
  our_team: number | null;
  /** 该 tick 在「播放时间轴」上的起始帧号（后端计算） */
  frame?: number | null;
}

/** 播放时间轴上的一段（phase 相同 且 比赛钟启停状态相同） */
export interface ReplaySegment {
  f0: number;
  f1: number;
  phase: number | null;
  /** phase 配置的倒计时秒数（0 = 无倒计时） */
  cd: number | null;
  gt0: number | null;
  gt1: number | null;
  dt: number;
  /** true = 比赛钟在走（比赛进行）；false = 冻结（进球庆祝 / 开球等待 / 赛前） */
  clock: boolean;
}

/**
 * 进球点。f=进球帧（= 比分跳变帧，精确）；
 * h/a=该球之后的累计比分；w0/w1=其后「开球等待」段起点 / 恢复比赛帧。
 */
export interface ReplayGoal {
  f: number;
  s: number;
  gt: number;
  h?: number;
  a?: number;
  w0?: number | null;
  w1?: number | null;
}

export interface ReplayTimeline {
  fps: number;
  total_frames: number;
  duration_sec: number;
  tick_indexed: boolean;
  segments: ReplaySegment[];
  goals?: ReplayGoal[];
  /** 仪式结束、正式开球的帧号（首个「比赛钟在走」的段起点） */
  kickoff_frame?: number | null;
}

export interface ReplayPrompts {
  tick_count: number;
  available: boolean;
  our_side: string | null;
  home_name: string | null;
  away_name: string | null;
  warnings?: string[];
  ticks: ReplayFrame[];
  timeline?: ReplayTimeline | null;
  timeline_reason?: string | null;
}

const CMD_COLOR: Record<string, string> = {
  SHOOT: "#ef4444",
  PASS: "#3b82f6",
  MOVE_TO: "#94a3b8",
  SLIDE_TACKLE: "#f59e0b",
  GK_DISTRIBUTE: "#a855f7",
  PRESS_BALL: "#22d3ee",
  MARK: "#22d3ee",
  INTERCEPT: "#22d3ee",
  FOLLOW_PLAYER: "#22d3ee",
  CLEAR_OVERRIDE: "#64748b",
  RESET: "#64748b",
  SET_STANCE: "#64748b",
};

const PHASE_LABEL: Record<number, string> = {
  1: "赛前倒计时",
  2: "更衣室",
  3: "对阵揭晓",
  4: "阵型选择",
  5: "开球等待",
  6: "开场视频",
  7: "比赛",
  9: "终场倒计时",
};

function phaseLabel(p: number | null | undefined): string {
  if (p == null) return "—";
  return PHASE_LABEL[p] ?? `阶段 ${p}`;
}

function cmdColor(c: string | null): string {
  if (!c) return "#64748b";
  return CMD_COLOR[c] ?? "#64748b";
}

function fmt(n: number | null | undefined, d = 1): string {
  return n == null ? "—" : n.toFixed(d);
}

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function lastIndexOfFrame(frames: number[], f: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let cur = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= f) {
      cur = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return cur;
}

function segmentAt(segments: ReplaySegment[], f: number): ReplaySegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (f < s.f0) hi = mid - 1;
    else if (f > s.f1) lo = mid + 1;
    else return s;
  }
  return null;
}

// ============================ 同步模型（纯函数，便于自测） ============================

export interface Anchor {
  /** performance.now() */
  t: number;
  frame: number;
  label: string;
  src: "click" | "client" | "visual" | "manual";
  /**
   * 事件类别。**只有同类锚点之间才允许比较斜率** —— 每类客户端日志各有自己的
   * "事件延迟"（日志打印时刻 − 画面真正到达该帧的时刻），混算会把这层延迟
   * 当成速率误差。详见 `estimateRate`。
   */
  kind?: string;
}

const SRC_LABEL: Record<Anchor["src"], string> = {
  click: "你点 START",
  client: "客户端日志",
  visual: "画面判定",
  manual: "手工校准",
};

export function frameAt(t: number, as: Anchor[], rate: number): number | null {
  if (!as.length) return null;
  if (as.length === 1 || t <= as[0].t) return as[0].frame + ((t - as[0].t) / 1000) * rate;
  for (let i = 0; i < as.length - 1; i += 1) {
    const a = as[i];
    const b = as[i + 1];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.frame;
      return a.frame + ((t - a.t) / span) * (b.frame - a.frame);
    }
  }
  const l = as[as.length - 1];
  return l.frame + ((t - l.t) / 1000) * rate;
}

/** 反向：帧号 → 预测的墙钟时刻（用于把日志与二进制事件配对） */
export function timeAt(frame: number, as: Anchor[], rate: number): number | null {
  if (!as.length) return null;
  if (as.length === 1) return as[0].t + ((frame - as[0].frame) / rate) * 1000;
  if (frame <= as[0].frame) return as[0].t + ((frame - as[0].frame) / rate) * 1000;
  for (let i = 0; i < as.length - 1; i += 1) {
    const a = as[i];
    const b = as[i + 1];
    if (frame <= b.frame) {
      const df = b.frame - a.frame;
      if (df <= 0) return b.t;
      return a.t + ((frame - a.frame) / df) * (b.t - a.t);
    }
  }
  const l = as[as.length - 1];
  return l.t + ((frame - l.frame) / rate) * 1000;
}

/**
 * 播放速率相对「录制标称帧率」的经验比值。
 * 后端从二进制算出的 `fps`（50.667）是**录制侧**帧率；客户端实际播放更快，
 * 四次独立实测（对 8~14 个进球点做最小二乘）得到 51.34 / 51.73 / 52.38 / 52.65，
 * 比值 1.013 ~ 1.039。用它当先验，能把"锚点还不够多"的头 ~20s 的漂移
 * 从 ≈0.9s 压到 ≈0.2s。
 */
const PLAYBACK_RATE_RATIO = 1.022;

/** 用全部锚点两两斜率取中位数 → 自校准播放速率 */
export function estimateRate(as: Anchor[], prior: number): number {
  // ⚠️ 必须排除「点击 → 开球」这一段：开场仪式是**压缩播放**的
  // （实测 3088 帧只走 24.4s ≈ 126fps），把它算进斜率会让面板在首次开球后跑到 2 倍速。
  const base = prior * PLAYBACK_RATE_RATIO;
  const solid = as.filter((a) => a.src !== "click");
  const slopes: number[] = [];
  for (let i = 0; i < solid.length; i += 1) {
    for (let j = i + 1; j < solid.length; j += 1) {
      const a = solid[i];
      const b = solid[j];
      // ⭐ 只比较**同类**事件（2026-10-01 定位）：每类日志各有自己的"事件延迟"，
      //    实测「正式开球」日志 ↔「首个进球」日志 之间还差 ≈0.42s。
      //    这段基线只有 4.9s，0.42s 的延迟被放大成 8.7% 的斜率误差：
      //      234 帧 / 4.89s = 47.9fps（真值 ≈52.4）
      //    而只有两个锚点时 estimateRate 只能返回这一个斜率 ⇒ 面板此后以 8.7%
      //    的速度持续落后，两次锚点间距 ~14s 就落后 1.1~2.0s（实测 -1.16s / -1.94s，
      //    且每次都是在"进球→倒数→开球"这段最显眼的时候暴露）。
      //    同类相比可让这层延迟互相抵消。
      if ((a.kind ?? a.src) !== (b.kind ?? b.src)) continue;
      const dt = (b.t - a.t) / 1000;
      const df = b.frame - a.frame;
      if (dt > 3 && df > 0) slopes.push(df / dt);
    }
  }
  // 同类锚点还不够（例如开场后只有 1 个进球）→ 退回先验，而不是拿一个可疑的两点斜率
  if (!slopes.length) return base;
  slopes.sort((a, b) => a - b);
  const med = slopes[slopes.length >> 1];
  // 样本极少（只有一对同类锚点）时向先验收缩：那是一根 20s 基线的两点斜率，
  // 端点各自的时标抖动会被完整放大。实测 2 锚点场景下可把误差从 −4.2% 收到 −2.3%。
  const w = Math.min(1, slopes.length / 3);
  const use = med * w + base * (1 - w);
  // 物理钳制：回放是匀速的，速率不会离先验太远
  return Math.min(base * 1.06, Math.max(base * 0.94, use));
}

/**
 * 进球庆祝视频的播放**时刻** vs 进球帧的**时刻**之差（毫秒）。
 * 实测（2026-10-01）：GOAL 日志 29.20s → Preparing video 29.54s → Video playing 30.46s，
 * 而进球帧 3322 对应 29.20s ⇒ 视频起播时回放已经走到 `进球帧 + 65 帧`。
 * 兜底锚点要按"视频起播时刻 − 1.26s = 进球帧时刻"来埋。
 */
const GOAL_VIDEO_LEAD_MS = 1260;
/** 兜底锚点允许的最大帧距（秒）——超过说明最近的进球不合适，宁可放弃 */
const GOAL_VIDEO_TOL_SEC = 8;

// =====================================================================================

export default function ReplayHud({
  data,
  homeName,
  awayName,
  matchId,
  onNeedTimeline,
}: {
  data: ReplayPrompts | null;
  homeName: string | null;
  awayName: string | null;
  matchId: string;
  onNeedTimeline?: () => void;
}) {
  const ticks = data?.ticks ?? [];
  const tl = data?.timeline ?? null;
  const hasTimelineField = !!data && "timeline" in data;
  const segments = useMemo(() => tl?.segments ?? [], [tl]);
  const goals = useMemo(() => tl?.goals ?? [], [tl]);
  const priorFps = tl?.fps || 50;
  const totalFrames = tl?.total_frames || 0;
  const kickoffFrame = useMemo(() => {
    if (!tl) return null;
    if (typeof tl.kickoff_frame === "number") return tl.kickoff_frame;
    const run = tl.segments.find((s) => s.clock);
    return run ? run.f0 : null;
  }, [tl]);

  const tickFrames = useMemo(() => {
    if (!ticks.length) return [] as number[];
    let last = -1;
    return ticks.map((t, i) => {
      const f = typeof t.frame === "number" ? t.frame : i;
      last = Math.max(last, f);
      return last;
    });
  }, [ticks]);

  const binUrl = useMemo(() => {
    if (!matchId) return "";
    try {
      return new URL(`/unity/replays/${matchId}`, window.location.href).href;
    } catch {
      return "";
    }
  }, [matchId]);

  const storageKey = matchId ? `replay-hud-off3:${matchId}` : "";

  const [paused, setPaused] = useState(false);
  const [offset, setOffset] = useState(0);
  const [frameIdx, setFrameIdx] = useState(0);
  const [anchorCount, setAnchorCount] = useState(0);
  const [anchorSrc, setAnchorSrc] = useState<Anchor["src"] | null>(null);
  const [anchorNote, setAnchorNote] = useState<string | null>(null);
  const [rate, setRate] = useState(50);
  const [lastCorr, setLastCorr] = useState<number | null>(null);
  const [readyState, setReadyState] = useState<"wait-data" | "wait-start" | "ceremony" | "live">(
    "wait-data",
  );
  const [live, setLive] = useState(false);
  const [clickAt, setClickAt] = useState<number | null>(null);
  const [samplerInfo, setSamplerInfo] = useState<{ sampler: string; green: number | null }>({
    sampler: "off",
    green: null,
  });
  const [clientFrames, setClientFrames] = useState<number | null>(null);
  const [clientPhase, setClientPhase] = useState<string | null>(null);
  /** 开场仪式进度：客户端逐阶段报（更衣室→开场视频→对阵揭晓→阵型选择→开球仪式→开球倒计时） */
  const [ceremony, setCeremony] = useState<{
    total: number;
    done: string[];
    cur: string | null;
    /** 当前阶段被触发的时刻（performance.now()），用于把"预计还需"做成实时倒数 */
    curAt: number;
  }>({ total: 0, done: [], cur: null, curAt: 0 });
  const [lastLog, setLastLog] = useState<string | null>(null);
  const [counts, setCounts] = useState({ goal: 0, phase: 0, click: 0, video: 0 });

  const anchorsRef = useRef<Anchor[]>([]);
  const rateRef = useRef(50);
  const priorRef = useRef(50);
  const offsetRef = useRef(0);
  const pausedRef = useRef(false);
  const holdRef = useRef(0);
  const startFrameRef = useRef(5);
  const goalsRef = useRef<ReplayGoal[]>([]);
  const kickoffRef = useRef<number | null>(null);
  const lastGoalLogAtRef = useRef(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  /** 客户端是否"真的开始播比赛"了（收到过任意非点击锚点）。没开播时绝不假装在推进。 */
  const liveRef = useRef(false);
  /** 只要收到过任意客户端日志，就说明"日志这条路是通的" ⇒ 关掉视觉兜底（避免误锚） */
  const logAliveRef = useRef(false);
  const pitchTimerRef = useRef<number | null>(null);
  const pitchAtRef = useRef(0);
  const clickAtRef = useRef<number | null>(null);

  useEffect(() => {
    priorRef.current = tl?.fps || 50;
    rateRef.current = rateRef.current || priorRef.current;
  }, [tl]);
  useEffect(() => {
    goalsRef.current = goals;
  }, [goals]);
  useEffect(() => {
    kickoffRef.current = kickoffFrame;
  }, [kickoffFrame]);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  /** 新增一个锚点：记录本次校正量，重算自校准速率 */
  const pushAnchor = useCallback((a: Anchor) => {
    const as = anchorsRef.current;
    const predicted = frameAt(a.t, as, rateRef.current);
    const next = [...as.filter((x) => Math.abs(x.t - a.t) > 80), a].sort((x, y) => x.t - y.t);
    anchorsRef.current = next;
    const r = estimateRate(next, priorRef.current);
    rateRef.current = r;
    setRate(r);
    setLastCorr(predicted == null ? null : (a.frame - predicted) / r);
    setAnchorCount(next.length);
    setAnchorSrc(a.src);
    setAnchorNote(a.label);
    if (a.src !== "click") {
      liveRef.current = true;
      setLive(true);
      setReadyState("live");
    }
  }, []);

  // ---------- 客户端日志：点击 / 开球 / 进球 / 阶段 ----------
  useEffect(() => {
    const off = subscribeLifecycle((e) => {
      logAliveRef.current = true;
      if (e.kind !== "other") setLastLog(e.text);

      if (e.kind === "playback_start") {
        // ⚠️ 这条出现在点击之前，只是"控制器就绪"（画面仍停在 START），不能当 t0。
        if (typeof e.frame === "number") startFrameRef.current = e.frame;
        if (typeof e.totalFrames === "number") setClientFrames(e.totalFrames);
        return;
      }
      if (e.kind === "ready_to_start" || e.kind === "data_ready") {
        setReadyState((s) => (s === "wait-data" ? "wait-start" : s));
        return;
      }
      if (e.kind === "user_click") {
        setCounts((c) => ({ ...c, click: c.click + 1 }));
        // 点击后客户端从 frame 5 开始走「开场仪式」（压缩播放，约 24s）：
        // 先按帧 5 锚定，仪式结束的 gameplay_start 会立刻把锚点纠正到开球帧。
        pushAnchor({
          t: e.at,
          frame: startFrameRef.current,
          label: "你点 START（开场仪式中…）",
          src: "click",
        });
        clickAtRef.current = e.at;
        setClickAt(e.at);
        setReadyState("ceremony");
        return;
      }
      if (e.kind === "ceremony_start") {
        setCeremony((c) => ({ ...c, total: e.ceremony?.total ?? 0 }));
        return;
      }
      if (e.kind === "ceremony_phase" && e.ceremony) {
        const nm = e.ceremony.name;
        setCeremony((c) => ({
          total: c.total || 0,
          cur: nm,
          curAt: e.at,
          done: c.done.includes(nm) ? c.done : [...c.done, nm],
        }));
        return;
      }
      if (e.kind === "gameplay_start" && typeof e.frame === "number") {
        // 权威锚点到手 → 取消"画面变绿"的兜底定时器
        if (pitchTimerRef.current != null) {
          window.clearTimeout(pitchTimerRef.current);
          pitchTimerRef.current = null;
        }
        pushAnchor({ t: e.at, frame: e.frame, label: `正式开球（帧 ${e.frame}）`, src: "client", kind: "kickoff" });
        setClientPhase("FIRST_HALF");
        return;
      }
      if (e.kind === "goal" && e.goal) {
        setCounts((c) => ({ ...c, goal: c.goal + 1 }));
        lastGoalLogAtRef.current = e.at;
        const k = goalsRef.current.findIndex((g) => g.h === e.goal!.h && g.a === e.goal!.a);
        if (k >= 0) {
          pushAnchor({
            t: e.at,
            frame: goalsRef.current[k].f,
            label: `进球 ${e.goal.h}-${e.goal.a}`,
            src: "client",
            kind: "goal",
          });
        } else {
          setLastLog(`进球 ${e.goal.h}-${e.goal.a}：回放文件里没有对应比分跳变`);
        }
        return;
      }
      if (e.kind === "phase_change" && e.phase) {
        setCounts((c) => ({ ...c, phase: c.phase + 1 }));
        setClientPhase(e.phase.to);
        // ⚠️ 这里**故意不做游标锚定**（实测有系统性偏差，2026-10-01）：
        //   客户端在「进球回放流程播完」时就把 phase 切成 COUNTDOWN_TO_KICKOFF
        //   （实测 +36.52s ≈ 回放帧 3703），而二进制里对应的 phase-5 段（w0）要到
        //   帧 3871 才开始 —— 相差 168 帧 / 3.3s。若按"最近时刻"配到 w0，会把游标
        //   向前硬跳 +2.79s，并把自校准速率从 50.1 污染到 65.3，之后要等下一个进球日志
        //   才纠得回来。开球 / 进球这两类权威日志已经给出精确锚点（15 个进球 ≈ 每 10s
        //   一次重锚），phase 日志只用作"客户端阶段"标签展示。
        return;
      }
      if (e.kind === "goal_video") {
        // 只作日志留痕：DOM 侧的 video hook 会单独计数并负责兜底锚定，避免重复计数
        setLastLog(e.text);
      }
    });
    return off;
  }, [pushAnchor]);

  // ---------- 浏览器侧备援：画面出现绿茵 / 进球视频 ----------
  useEffect(() => {
    const off = subscribePlayback((s) => {
      if (s.kind === "pitch") {
        // 画面出现大片绿茵 = 开球。此时锚到 kickoff_frame（二进制推出的精确帧）。
        // ⚠️ 但**仪式阶段本身就在渲染球场**（MATCHUP_REVEAL / FORMATION_SELECTION /
        // KICK_OFF 的绿茵占比实测能到 36~48%，和真实比赛重叠）⇒ 只要客户端日志这条
        // 路是通的（收到过任意一条），就**完全不用视觉兜底**，否则会在仪式中提前锚定、
        // 让面板超前 10s 左右（实测过）。
        const kf = kickoffRef.current;
        if (kf == null || liveRef.current || logAliveRef.current || pitchTimerRef.current != null) return;
        pitchAtRef.current = s.at;
        pitchTimerRef.current = window.setTimeout(() => {
          pitchTimerRef.current = null;
          if (liveRef.current || logAliveRef.current) return;
          pushAnchor({ t: pitchAtRef.current, frame: kf, label: "画面出现球场（视觉判定）", src: "visual" });
        }, 2500);
        return;
      }
      if (s.kind === "goal_video") {
        setCounts((c) => ({ ...c, video: c.video + 1 }));
        // ⚠️ 必须在"比赛已经开播"之后才允许用视频兜底。实测（2026-10-01）客户端**在加载
        //    阶段就 preload 了 goal_anim_4K.mp4**（日志 `[GoalOverlayUI] PreloadVideo: …`，
        //    早于用户点击 16.5s），开场仪式里还会 play 一次 ⇒ 此时 `lastGoalLogAtRef` 仍是 0、
        //    `silent` 恒真，于是被误判成"第 1 个进球"，把游标钉到 goals[0].f+18=3340 帧、
        //    首次校正量 **+65.3s**，整个 24s 仪式期面板都在错误的帧上游走。
        if (!liveRef.current) return;
        const as = anchorsRef.current;
        if (!as.length) return;
        if (s.at - lastGoalLogAtRef.current <= 5000) return;
        const cur = frameAt(s.at, as, rateRef.current);
        if (cur == null) return;
        // 配"离当前游标最近的那个进球"，而不是数第 k 个视频事件（视频可能被重复触发）
        let best: ReplayGoal | null = null;
        let bd = Infinity;
        for (const g of goalsRef.current) {
          const d = Math.abs(g.f - cur);
          if (d < bd) {
            bd = d;
            best = g;
          }
        }
        if (best && bd <= rateRef.current * GOAL_VIDEO_TOL_SEC) {
          pushAnchor({
            t: s.at - GOAL_VIDEO_LEAD_MS,
            frame: best.f,
            label: `进球视频 ${best.h ?? "?"}-${best.a ?? "?"}（日志缺失兜底）`,
            src: "visual",
          });
        }
      }
    });
    return off;
  }, [pushAnchor]);

  // ---------- 切场复位 ----------
  useEffect(() => {
    setPaused(false);
    setFrameIdx(0);
    anchorsRef.current = [];
    holdRef.current = 0;
    startFrameRef.current = 5;
    rateRef.current = priorRef.current;
    setRate(priorRef.current);
    lastGoalLogAtRef.current = 0;
    liveRef.current = false;
    logAliveRef.current = false;
    clickAtRef.current = null;
    if (pitchTimerRef.current != null) {
      window.clearTimeout(pitchTimerRef.current);
      pitchTimerRef.current = null;
    }
    setLive(false);
    setClickAt(null);
    setAnchorSrc(null);
    setAnchorNote(null);
    setAnchorCount(0);
    setLastCorr(null);
    setReadyState("wait-data");
    setClientPhase(null);
    setClientFrames(null);
    setCeremony({ total: 0, done: [], cur: null, curAt: 0 });
    setLastLog(null);
    setCounts({ goal: 0, phase: 0, click: 0, video: 0 });
    let v = 0;
    if (storageKey) {
      const s = window.localStorage.getItem(storageKey);
      if (s != null && Number.isFinite(Number(s))) v = Number(s);
    }
    offsetRef.current = v;
    setOffset(v);
  }, [matchId, storageKey]);

  // ---------- 主循环：锚点模型 → 当前帧号 ----------
  useEffect(() => {
    if (!totalFrames) return;
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      let f: number;
      if (pausedRef.current) {
        f = holdRef.current;
      } else if (!liveRef.current) {
        // ⚠️ 客户端还没正式开球（可能画面仍停在 START / 开场仪式里帧号未知）⇒
        // **绝不外推**，把游标停在点击时的那一帧，状态栏如实说明"帧号未知"。
        // 实测踩过：只靠点击锚点外推，165s 后会把"仍停在 START 的画面"显示成帧 8418「比赛进行」。
        f = clickAtRef.current == null ? 0 : startFrameRef.current;
      } else {
        const v = frameAt(now, anchorsRef.current, rateRef.current);
        f = v == null ? 0 : v + offsetRef.current * rateRef.current;
      }
      f = Math.max(0, Math.min(totalFrames - 1, f));
      const fi = Math.round(f);
      setFrameIdx((prev) => (prev === fi ? prev : fi));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [totalFrames]);

  // 采样器状态（绿茵占比）刷新到面板诊断里 —— 便于判断"画面到底在放什么"
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = playbackSnapshot();
      setSamplerInfo({ sampler: s.sampler, green: s.green });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // 首播时 HUD 可能早于回放二进制落盘 → 到货后静默重取一次
  const refetchAskedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data || tl || !binUrl || !onNeedTimeline || !matchId) return;
    if (refetchAskedRef.current.has(matchId)) return;
    let raf = 0;
    let tries = 0;
    const watch = () => {
      tries += 1;
      try {
        const ents = performance.getEntriesByName(binUrl, "resource") as PerformanceResourceTiming[];
        if (ents.length) {
          refetchAskedRef.current.add(matchId);
          window.setTimeout(() => onNeedTimeline(), 300);
          return;
        }
      } catch {
        /* Resource Timing 不可用 */
      }
      if (tries < 3600) raf = requestAnimationFrame(watch);
      else refetchAskedRef.current.add(matchId);
    };
    raf = requestAnimationFrame(watch);
    return () => cancelAnimationFrame(raf);
  }, [data, tl, binUrl, onNeedTimeline, matchId]);

  const setOffsetAndPersist = useCallback(
    (v: number) => {
      const cl = Math.max(-600, Math.min(600, v));
      offsetRef.current = cl;
      setOffset(cl);
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, String(cl));
        } catch {
          /* 隐私模式等忽略 */
        }
      }
    },
    [storageKey],
  );

  /** 暂停跟随并停到某帧 */
  const seek = useCallback((frame: number) => {
    const target = Math.max(0, Math.min(totalFrames - 1, frame));
    holdRef.current = target;
    setFrameIdx(target);
    setPaused(true);
  }, [totalFrames]);

  /** 恢复跟随：清掉手工微调，重新跟锚点 */
  const resumeFollow = useCallback(() => {
    setOffsetAndPersist(0);
    setPaused(false);
    const kf = kickoffRef.current;
    if (kf != null && !anchorsRef.current.length) {
      pushAnchor({ t: performance.now(), frame: kf, label: "手工指定：此刻=开球", src: "manual" });
    }
  }, [pushAnchor, setOffsetAndPersist]);

  const togglePlay = () => {
    if (!pausedRef.current) {
      holdRef.current = frameIdx;
      setPaused(true);
    } else setPaused(false);
  };

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el || !totalFrames) return;
      const r = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      seek(ratio * (totalFrames - 1));
    },
    [seek, totalFrames],
  );

  const curTickIdx = useMemo(() => lastIndexOfFrame(tickFrames, frameIdx), [tickFrames, frameIdx]);
  const frame = curTickIdx >= 0 ? ticks[curTickIdx] : null;
  /** 当前帧所属的播放段（比赛进行 / 进球庆祝 / 开球等待 …）。
   *  ⚠️ 必须声明在下面几个派生量之前——它们是 const，不走变量提升，
   *     在初始化前访问会抛 `Cannot access 'seg' before initialization`。 */
  const seg = useMemo(() => segmentAt(segments, frameIdx), [segments, frameIdx]);
  /**
   * 面板手上的指令"旧"了多久（秒）。
   * 引擎（tick_prompts）每 ~2s 才决策一次 ⇒ 开球那一刻能显示的最新决策，
   * 本身就是"倒数期间"下的，这段滞后是**数据粒度**，不是同步误差。
   * 实测开球瞬间的 tick 落后 0.16~1.72s。显式标出来，避免被误读成"面板没对齐"。
   */
  const cmdLagSec =
    curTickIdx >= 0 && tickFrames[curTickIdx] != null && rate > 0
      ? Math.max(0, (frameIdx - tickFrames[curTickIdx]) / rate)
      : null;

  /**
   * 按**帧号**精确推算比分（实测：客户端画面记分牌在进球帧就跳，而 tick 快照
   * 每 ~2s 才更新一次 ⇒ 直接用 tick 的 score 会让比分最多滞后 ~2s，这正是
   * 用户看到的"进球后 prompt 那边总是慢一截"）。
   * `goals[].h/a` 是累计比分，取最后一个 f ≤ 当前帧即可。
   */
  const scoreAtFrame = useMemo(() => {
    if (!goals.length) return null;
    let cur: { h: number; a: number } | null = null;
    for (const g of goals) {
      if (typeof g.f === "number" && g.f <= frameIdx) {
        cur = { h: g.h ?? 0, a: g.a ?? 0 };
      }
    }
    return cur; // 首个进球之前为 null（0:0）
  }, [goals, frameIdx]);

  /**
   * 按**帧号**插值比赛钟（段内 gameTime 每帧线性 +dt）。
   * 同样比「tick 快照里的 gameTime」平滑——后者每 ~2s 跳一次。
   */
  const gameTimeAtFrame = useMemo(() => {
    if (!seg) return null;
    if (!seg.clock || seg.gt0 == null) return seg.gt0 ?? null;
    const dt = seg.dt || 0.02;
    return seg.gt0 + (frameIdx - seg.f0) * dt;
  }, [seg, frameIdx]);
  const ourTeam = frame?.our_team ?? data?.ticks?.[0]?.our_team ?? null;

  const cmdsByTeam = useMemo(() => {
    const out: Record<number, ReplayCmd[]> = { 0: [], 1: [] };
    for (const c of frame?.cmds ?? []) {
      const team = c.team ?? -1;
      if (team === 0 || team === 1) out[team].push(c);
    }
    for (const k of [0, 1]) out[k].sort((a, b) => (a.pid ?? 9) - (b.pid ?? 9));
    return out;
  }, [frame]);

  const panel = (children: React.ReactNode, color = "#cbd5e1") => (
    <div
      style={{
        width: 440,
        flex: "0 0 440px",
        borderLeft: "1px solid #222a38",
        padding: 12,
        color,
        font: "12px/1.5 ui-monospace,Consolas,monospace",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {children}
    </div>
  );

  if (!data) {
    return panel(
      <>
        <div style={{ color: "#9fe3b0", fontWeight: 600 }}>同步指令 / 状态</div>
        <div>选择一场比赛后，这里会随 Unity 回放同步显示逐 tick 的 gameState 与双方 agent 指令。</div>
      </>,
      "#64748b",
    );
  }

  if (!data.available || !ticks.length) {
    return panel(
      <>
        <div style={{ fontWeight: 600 }}>同步指令 / 状态</div>
        <div>本场无 tick 数据（赛后保留期已过或上游未返回 prompts）。</div>
        {data.warnings?.length ? (
          <div style={{ color: "#64748b", marginTop: 6 }}>{data.warnings.join("; ")}</div>
        ) : null}
      </>,
      "#f59e0b",
    );
  }

  const wall = frameIdx / (rate || priorFps);
  const running = seg ? seg.clock : false;
  const frozen = !!seg && !seg.clock;
  const pct = (f: number) => `${Math.max(0, Math.min(100, (f / Math.max(1, totalFrames - 1)) * 100))}%`;
  const anchored = anchorCount > 0 && !paused;
  const corrBad = lastCorr != null && Math.abs(lastCorr) > 1.5;

  let statusColor = "#f59e0b";
  let statusNode: React.ReactNode;
  if (!tl) {
    statusColor = hasTimelineField ? "#f59e0b" : "#f87171";
    statusNode = !hasTimelineField ? (
      <>
        ⚠ 后端未返回时间轴数据（响应缺 timeline 字段） — <b>请重启后端</b>并刷新
      </>
    ) : data.timeline_reason === "decode_failed" ? (
      <>⚠ 本场回放二进制解码失败 — 只能手动逐 tick 查看</>
    ) : (
      <>⚠ 本场回放二进制尚未缓存 → 时间轴待生成（下载后自动重取）</>
    );
  } else if (!live && clickAt != null) {
    // 已点了 START，但客户端还没报出「正式开球」——帧号未知，如实说明。
    // 但这 24s 不是"黑箱"：客户端在逐阶段报仪式进度，把它显示出来（序列见 lifecycle.ts 头注释）。
    const el = (performance.now() - clickAt) / 1000;
    const stuck = el > 45 && !ceremony.cur;
    const remain0 = ceremonyRemainSec(ceremony.cur);
    // 实时倒数：阶段触发时按上一场实测节奏给出预计，之后逐秒回落
    const remain =
      remain0 == null || !ceremony.curAt
        ? null
        : Math.max(0, remain0 - (performance.now() - ceremony.curAt) / 1000);
    const idx = ceremony.done.length;
    const total = ceremony.total || 6;
    // "已过阶段"不含当前阶段（当前阶段已经在标题里了）
    const passed = ceremony.cur ? ceremony.done.filter((n) => n !== ceremony.cur) : ceremony.done;
    statusColor = stuck ? "#f87171" : "#f59e0b";
    statusNode = (
      <>
        {stuck
          ? `⚠ 客户端似乎没有开始播放（已等 ${el.toFixed(0)}s）`
          : ceremony.cur
            ? `⏳ 开场仪式 ${idx}/${total}：${phaseNameZh(ceremony.cur)}（帧号未知）`
            : "⏳ 开场仪式中…（帧号未知，等待正式开球）"}
        <div style={{ color: "#94a3b8", marginTop: 4 }}>
          {stuck ? (
            "画面可能仍停在 START：请在画面里点 START 按钮。面板不会在没开播时假装推进。"
          ) : (
            <>
              这 24s 客户端<b>不逐帧推进回放</b>（只放仪式 / 阵型展示），所以帧号无从得知；仪式一结束
              就用日志把游标钉到开球帧 {kickoffFrame ?? "—"}。
              {remain != null ? (
                <>
                  <br />
                  预计还差 <b>{remain <= 0 ? "不到 1" : remain.toFixed(0)}s</b> 正式开球
                  <span style={{ color: "#64748b" }}>（按上一场实测节奏推算，仅供参考）</span>
                </>
              ) : null}
            </>
          )}
        </div>
        <div style={{ color: "#475569", fontSize: 10, marginTop: 3 }}>
          {passed.length ? `已过阶段：${passed.map((n) => phaseNameZh(n)).join(" → ")} · ` : ""}
          点击后 {el.toFixed(0)}s
        </div>
      </>
    );
  } else if (anchorCount > 0) {
    statusColor = paused ? "#94a3b8" : corrBad ? "#f59e0b" : "#9fe3b0";
    statusNode = (
      <>
        {paused ? "⏸ 已暂停跟随（手工查看中）" : "✅ 已与客户端画面同步"}
        <div style={{ color: "#94a3b8", marginTop: 3 }}>
          最近锚点：{anchorNote}
          {anchorSrc ? ` · 来源：${SRC_LABEL[anchorSrc]}` : ""}
        </div>
        <div style={{ color: "#475569", fontSize: 10 }}>
          锚点 {anchorCount} 个 · 自校准速率 {rate.toFixed(2)} fps
          {lastCorr != null ? ` · 上次校正 ${lastCorr > 0 ? "+" : ""}${lastCorr.toFixed(2)}s` : ""}
          {offset !== 0 ? ` · 手工微调 ${offset > 0 ? "+" : ""}${offset.toFixed(2)}s` : ""}
        </div>
      </>
    );
  } else {
    statusNode =
      readyState === "wait-start" ? (
        <>
          ⏸ 等待开播 — <b>请在画面里点 START</b>
          <div style={{ color: "#94a3b8", marginTop: 4 }}>
            点下去即自动对齐；开球后每次进球/开球等待都会用客户端日志逐条重锚，漂移不会累积。
          </div>
        </>
      ) : (
        <>
          ⏳ 等待回放客户端就绪…
          <div style={{ color: "#94a3b8", marginTop: 4 }}>Unity 加载完会先显示 START 界面。</div>
        </>
      );
  }

  const renderTeam = (team: number, label: string) => {
    const isOurs = team === ourTeam;
    return (
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontSize: 11,
            color: isOurs ? "#3b82f6" : "#94a3b8",
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          {label}
          {isOurs ? " · 我方" : ""}
        </div>
        {cmdsByTeam[team].map((c, i) => {
          const dl = durLabel(c.duration);
          const corner = isCornerShot(c);
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                padding: "2px 0",
                font: "11px/1.4 ui-monospace,Consolas,monospace",
              }}
            >
              <span style={{ color: "#64748b", width: 26, flex: "0 0 26px" }}>P{c.pid ?? "?"}</span>
              <span
                style={{
                  background: cmdColor(c.cmd),
                  color: "#0b0f17",
                  borderRadius: 3,
                  padding: "1px 5px",
                  fontWeight: 700,
                  minWidth: 64,
                  textAlign: "center",
                  fontSize: 10,
                  flex: "0 0 auto",
                }}
              >
                {c.cmd ?? "?"}
              </span>
              {/* 参数摘要：后端已透出完整 parameters，这里按命令语义排版。
                  「打角落」的射门（aim≠CENTER，全库仅 8.3%）用琥珀色加粗突出。 */}
              <span
                style={{
                  color: corner ? "#f59e0b" : "#cbd5e1",
                  fontWeight: corner ? 700 : 400,
                  flex: 1,
                  minWidth: 0,
                  wordBreak: "break-word",
                }}
                title={corner ? "非中路射门（打角落）——全库仅 8.3%，是 prompt 差异的强信号" : undefined}
              >
                {cmdDetail(c)}
              </span>
              {c.sprint ? (
                <span style={{ color: "#f59e0b", flex: "0 0 auto" }} title="sprint = 冲刺">
                  ⚡
                </span>
              ) : null}
              {dl ? (
                <span
                  style={{
                    color: "#38bdf8",
                    fontSize: 10,
                    border: "1px solid #1e3a5f",
                    borderRadius: 3,
                    padding: "0 3px",
                    flex: "0 0 auto",
                  }}
                  title={`duration=${c.duration}（0=一次性 / >0=持续秒数 / -1=持续到被覆盖）`}
                >
                  {dl}
                </span>
              ) : null}
            </div>
          );
        })}
        {cmdsByTeam[team].length === 0 ? (
          <div style={{ color: "#475569", fontSize: 11 }}>（无指令）</div>
        ) : null}
      </div>
    );
  };

  return panel(
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#9fe3b0", fontWeight: 600 }}>同步指令 / 状态</span>
        <span style={{ color: "#64748b", fontSize: 11 }}>
          {homeName ?? data.home_name ?? "HOME"} vs {awayName ?? data.away_name ?? "AWAY"}
        </span>
      </div>

      <div
        style={{
          background: "#0b0f17",
          border: `1px solid ${statusColor === "#f87171" ? "#7f1d1d" : "#1e293b"}`,
          borderRadius: 6,
          padding: 8,
          color: statusColor,
          fontSize: 11,
        }}
      >
        {statusNode}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <button onClick={() => seek(frameIdx - (tl ? rate : 1))} style={btn("#1e293b")}>
          ◀◀
        </button>
        <button onClick={togglePlay} style={btn(paused ? "#f59e0b" : "#1e293b")}>
          {paused ? "▶ 跟随" : "⏸ 暂停"}
        </button>
        <button onClick={() => seek(frameIdx + (tl ? rate : 1))} style={btn("#1e293b")}>
          ▶▶
        </button>
        <button onClick={resumeFollow} style={btn("#1e293b")} title="清掉手工微调，重新跟随客户端锚点">
          ⟲ 重对齐
        </button>
        <button onClick={() => setOffsetAndPersist(offset - 0.25)} style={btn("#1e293b")}>
          −0.25s
        </button>
        <button onClick={() => setOffsetAndPersist(offset + 0.25)} style={btn("#1e293b")}>
          +0.25s
        </button>
      </div>

      {tl ? (
        <>
          <div
            ref={stripRef}
            onPointerDown={(e) => {
              draggingRef.current = true;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              seekFromPointer(e.clientX);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) seekFromPointer(e.clientX);
            }}
            onPointerUp={(e) => {
              draggingRef.current = false;
              (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
            }}
            style={{
              position: "relative",
              height: 22,
              background: "#0b0f17",
              border: "1px solid #1e293b",
              borderRadius: 4,
              overflow: "hidden",
              cursor: "crosshair",
              touchAction: "none",
            }}
            title="拖动定位；绿=比赛进行，琥珀=动画/等待，⚽=进球"
          >
            {segments.map((s, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: pct(s.f0),
                  width: `calc(${pct(s.f1 - s.f0 + 1)} + 0.5px)`,
                  background: s.clock ? "#14532d" : "#78350f",
                }}
              />
            ))}
            {goals.map((g, i) => (
              <div
                key={`g${i}`}
                title={`进球 · 帧 ${g.f} · ${g.s === 0 ? "HOME" : "AWAY"} · 比分 ${g.h ?? "?"}-${g.a ?? "?"} · 比赛钟 ${g.gt}s`}
                style={{
                  position: "absolute",
                  top: 1,
                  left: pct(g.f),
                  transform: "translateX(-50%)",
                  fontSize: 11,
                  lineHeight: "16px",
                  filter: g.s === ourTeam ? "none" : "grayscale(0.6)",
                }}
              >
                ⚽
              </div>
            ))}
            {kickoffFrame != null ? (
              <div
                title={`开球 · 帧 ${kickoffFrame}`}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: pct(kickoffFrame),
                  width: 1,
                  background: "#38bdf8",
                }}
              />
            ) : null}
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: pct(frameIdx),
                width: 2,
                background: "#e2e8f0",
                boxShadow: "0 0 4px #e2e8f0",
              }}
            />
          </div>
          <div style={{ color: "#64748b", fontSize: 11 }}>
            墙钟 {mmss(wall)} / {mmss(tl.duration_sec)} · 帧 {frameIdx}/{totalFrames} ·{" "}
            {rate.toFixed(1)}fps{goals.length ? ` · 进球 ${goals.length}` : ""}
            {clientFrames && clientFrames !== totalFrames ? ` · 客户端帧数 ${clientFrames}` : ""}
            {cmdLagSec != null && frame?.t != null ? (
              <span
                style={{ color: cmdLagSec > 1.2 ? "#f59e0b" : "#64748b" }}
                title="引擎每约 2s 才下发一次决策，所以这是数据固有的粒度，不是面板没对齐"
              >
                {" · "}指令 tick {frame.t}（{cmdLagSec.toFixed(1)}s 前）
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <div style={{ color: "#64748b", fontSize: 11 }}>
          tick {curTickIdx + 1}/{ticks.length}
        </div>
      )}

      {tl ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            flexWrap: "wrap",
            color: running ? "#9fe3b0" : "#f59e0b",
          }}
        >
          <span>{!live ? "⏳ 未开播 / 开场仪式" : running ? "▶ 比赛进行" : "⏸ 动画/等待中"}</span>
          <span style={{ color: "#475569" }}>
            {live ? phaseLabel(seg?.phase) : "帧号未知"}
            {live && seg && seg.cd ? ` · 倒计时 ${seg.cd}s` : ""}
          </span>
          {!live && ceremony.cur ? (
            <span style={{ color: "#3b82f6" }}>
              仪式 {ceremony.done.length}/{ceremony.total || 6}：{phaseNameZh(ceremony.cur)}
            </span>
          ) : null}
          {clientPhase ? (
            <span style={{ color: "#3b82f6" }}>客户端：{phaseNameZh(clientPhase)}</span>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          background: "#0b0f17",
          border: "1px solid #1e293b",
          borderRadius: 6,
          padding: 8,
        }}
      >
        <div style={{ color: "#9fe3b0", fontSize: 11, marginBottom: 4 }}>
          GAME STATE {frame ? `· tick ${frame.t ?? "—"}` : "· 未开球"}
        </div>
        {frame ? (
          <>
            <div>
              比分{" "}
              {/* ⭐ 用按帧推算的比分；tick 快照最多慢 ~2s，只在没有 goals 时兜底 */}
              <b style={{ color: "#e2e8f0" }}>
                {scoreAtFrame
                  ? `${scoreAtFrame.h} : ${scoreAtFrame.a}`
                  : `${fmt(frame.score?.home, 0)} : ${fmt(frame.score?.away, 0)}`}
              </b>
              <span style={{ color: "#64748b" }}>
                {" "}· 比赛钟 {fmt(gameTimeAtFrame ?? frame.gameTime)}s
              </span>
            </div>
            <div>
              球{" "}
              <b style={{ color: "#e2e8f0" }}>
                x={fmt(frame.ball?.x)} z={fmt(frame.ball?.z)}
              </b>
              {/* 球位置只有 tick 快照，按帧推不出来 —— 如实标出它的时间 */}
              {cmdLagSec != null && cmdLagSec > 0.4 ? (
                <span style={{ color: "#64748b", fontSize: 10 }}>
                  {" "}（tick {frame.t ?? "—"} 快照，{cmdLagSec.toFixed(1)}s 前）
                </span>
              ) : null}
            </div>
            <div>
              控球 <b style={{ color: "#e2e8f0" }}>{frame.poss ? String(frame.poss) : "—"}</b>
              {frame.poss_team != null ? ` (${frame.poss_team === ourTeam ? "我方" : "对手"})` : null}
            </div>
            {tickFrames.length && frameIdx < tickFrames[0] ? (
              <div style={{ color: "#475569", fontSize: 10, marginTop: 3 }}>
                该帧早于第一条 tick（{tickFrames[0]}），显示的是赛前状态
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ color: "#64748b" }}>
            {frozen ? "赛前 / 开场序列" : anchored ? "尚未到达第一条 tick" : "未开播"}
          </div>
        )}
      </div>

      {renderTeam(0, "HOME / 0 队")}
      {renderTeam(1, "AWAY / 1 队")}

      <div style={{ color: "#334155", fontSize: 10, marginTop: "auto", paddingTop: 6 }}>
        诊断 · 锚点 {anchorCount} · 进球日志 {counts.goal} · 阶段日志 {counts.phase} · 进球视频 {counts.video} ·
        点击 {counts.click} · 画面采样 {samplerInfo.sampler}
        {samplerInfo.green != null ? `(绿茵 ${(samplerInfo.green * 100).toFixed(0)}%)` : ""}
        {lastLog ? <div style={{ color: "#475569" }}>{lastLog}</div> : null}
      </div>
    </>,
  );
}

function btn(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 5,
    padding: "4px 8px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "ui-monospace,Consolas,monospace",
  };
}
