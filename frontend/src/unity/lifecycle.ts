/**
 * unity/lifecycle.ts — 抓 Unity 回放客户端自己的 console 日志，作为**同步锚点**。
 *
 * 全部来自实测（2026-10-01，真实 Chromium，点中 START 后完整跑一场）：
 *
 *   [ReplayDownloader] Blob deserialized: 19686 frames
 *   [ClickToStartUI] Loading complete — showing START button
 *   [ClickToStartUI] User clicked START — enabling autoplay            ← 用户点击
 *   [ReplayPlaybackController] Applied MatchConfig: A vs B
 *   [ReplayPlaybackController] Playback started at frame 5: 19686 frames, duration=120.1s
 *   [ReplayClientBootstrap] Playing 6 ceremony phases before gameplay  ← 仪式总阶段数
 *   [ReplayClientBootstrap] Skipping ceremony phase LOCKER_ROOM (already handled), wait=0ms
 *   [ReplayClientBootstrap] Skipping ceremony phase OPENING_VIDEO (already handled), wait=3000ms
 *   [ReplayClientBootstrap] Triggering ceremony phase: MATCHUP_REVEAL ← ⭐ 仪式进度（注意冒号位置与 Skipping 不同）
 *   [ReplayClientBootstrap] Triggering ceremony phase: FORMATION_SELECTION
 *   [ReplayClientBootstrap] Triggering ceremony phase: KICK_OFF
 *   [ReplayClientBootstrap] Triggering ceremony phase: COUNTDOWN_TO_KICKOFF
 *   [ReplayClientBootstrap] Ceremony complete. Gameplay starts at frame 3088  ← ⭐ 正式开球帧
 *   [ReplayClientBootstrap] GOAL detected: Home 1-0                    ← ⭐ 每次进球（累计比分）
 *   [GoalOverlayUI] Preparing video: …/video/goal_anim_4K.mp4          ← ⭐ DOM 级备援
 *   [GoalOverlayUI] Video playing / Video ended / Flow complete
 *   [ReplayClientBootstrap] Phase: FIRST_HALF → COUNTDOWN_TO_KICKOFF   ← 仅作标签（与二进制帧无时间映射）
 *   [ReplayClientBootstrap] Phase: COUNTDOWN_TO_KICKOFF → FIRST_HALF
 *
 * 实测要点（务必保留，都是踩过的坑）：
 *  1. **真正开播 = 用户点画面里的 START 按钮**（画布 50% × 82% 处）。没有点击则永远停在
 *     START 界面（实测挂了 240s 画面纹丝不动）。点击生效的第一条判据是
 *     `Playing 6 ceremony phases before gameplay`。
 *  2. `Playback started at frame 5` 只是**控制器就绪**，出现在点击之前，不能当 t0。
 *  3. 开球前约 24s 是「开场仪式」，客户端在这段时间**不逐帧推进回放**（阶段等待结束后
 *     直接 `Playback started at frame 3088`）⇒ **帧号不可知，绝不能用点击锚点外推**，
 *     只能按仪式阶段报进度。实测各阶段相对点击时刻：MATCHUP_REVEAL +3.36s /
 *     FORMATION_SELECTION +15.37s / KICK_OFF +15.37s / COUNTDOWN_TO_KICKOFF +19.52s
 *     → `Ceremony complete` +24.53s。
 *  4. 开球后是**匀速逐帧**播放，实测 ≈ 51.7 fps（不是录制时的 50 fps）。
 *     用 12 个进球点做最小二乘：t = 24.43 + (f-3088)/51.73，末端误差 0.01s。
 *  5. 进球时客户端会播 `goal_anim_4K.mp4` —— `HTMLMediaElement.play` 也能看到，
 *     是不依赖 console 补丁的备援信号。**但加载期就 preload 过它**（早于点击 16.5s），
 *     所以这条信号必须"开播之后"才可用。
 */

export type LifecycleKind =
  | "playback_start" // 控制器就绪 / 正式开播（带 frame）
  | "user_click" // 用户点了 START
  | "ceremony_start" // 开场仪式开始（带阶段总数）
  | "ceremony_phase" // 开场仪式逐阶段推进（更衣室/对阵揭晓/阵型选择/开球倒计时…）
  | "gameplay_start" // 仪式结束、正式开球（带 frame）
  | "goal" // 进球（带累计比分）
  | "goal_video" // 进球庆祝视频开始播放（DOM 级备援）
  | "phase_change" // 阶段切换（如 FIRST_HALF → COUNTDOWN_TO_KICKOFF）
  | "ready_to_start" // START 界面出现
  | "data_ready" // 回放二进制反序列化完成
  | "match_info" // 拿到 MatchConfig
  | "other";

/** 仪式阶段信息（ceremony_start 只填 total；ceremony_phase 填 name/skipped/waitMs） */
export interface CeremonyInfo {
  name: string;
  /** `Skipping …` = 该阶段在加载期已放过，仪式里只等 waitMs 不重放 */
  skipped: boolean;
  /** 客户端自报的等待时长（ms），Skipping 行会带，Triggering 行可能没有 */
  waitMs: number | null;
  /** 仪式阶段总数（`Playing N ceremony phases`），未知为 0 */
  total: number;
}


export interface LifecycleEvent {
  kind: LifecycleKind;
  /** performance.now() */
  at: number;
  /** playback_start / gameplay_start 携带的帧号 */
  frame: number | null;
  /** playback_start 携带的回放总帧数 / 客户端自报比赛时长 */
  totalFrames: number | null;
  duration: number | null;
  /** goal：进球方 + 累计比分 */
  goal?: { side: string; h: number; a: number } | null;
  /** phase_change：从/到 */
  phase?: { from: string; to: string } | null;
  /** ceremony_start / ceremony_phase：开场仪式进度 */
  ceremony?: CeremonyInfo | null;
  /** goal_video：视频文件名 */
  detail?: string | null;
  /** 原始整行，供面板诊断 */
  text: string;
}

const PLAYBACK_START_RE =
  /\[ReplayPlaybackController\]\s*Playback started at frame\s+(\d+)\s*:\s*(\d+)\s*frames,\s*duration=\s*([\d.]+)\s*s/i;
const GAMEPLAY_START_RE =
  /\[ReplayClientBootstrap\]\s*Ceremony complete\.\s*Gameplay starts at frame\s+(\d+)/i;
const GOAL_RE = /\[ReplayClientBootstrap\]\s*GOAL detected:\s*([A-Za-z_]+)\s+(\d+)\s*-\s*(\d+)/i;
const PHASE_CHANGE_RE = /\[ReplayClientBootstrap\]\s*Phase:\s*([A-Za-z_]+)\s*[→>-]+\s*([A-Za-z_]+)/i;
/** `Playing 6 ceremony phases before gameplay` */
const CEREMONY_START_RE = /\[ReplayClientBootstrap\]\s*Playing\s+(\d+)\s+ceremony phases?\b/i;
/**
 * 仪式阶段推进。两种写法**冒号位置不同**，必须都覆盖：
 *   `Skipping ceremony phase LOCKER_ROOM (already handled), wait=0ms`
 *   `Triggering ceremony phase: MATCHUP_REVEAL`
 */
const CEREMONY_PHASE_RE =
  /\[ReplayClientBootstrap\]\s*(Skipping|Triggering) ceremony phase:?\s*([A-Za-z_]+)(?:\s*\(([^)]*)\))?\s*,?\s*(?:wait=(\d+)\s*ms)?/i;
const USER_CLICK_RE = /\[ClickToStartUI\]\s*User clicked START/i;
const READY_RE = /\[ClickToStartUI\]\s*Loading complete|\[ReplayClient\]\s*Click START to begin replay/i;
const DATA_RE = /\[ReplayDownloader\]\s*Blob deserialized:\s*(\d+)\s*frames/i;
const MATCH_INFO_RE = /\[ReplayPlaybackController\]\s*Applied MatchConfig/i;
const GOAL_VIDEO_RE = /\[GoalOverlayUI\]\s*Video playing/i;
const GOAL_VIDEO_PREP_RE = /\[GoalOverlayUI\]\s*Preparing video:\s*(\S+)/i;

const INTERESTING = [
  "[ReplayPlaybackController]",
  "[ReplayDownloader]",
  "[ClickToStartUI]",
  "[ReplayClientBootstrap]",
  "[ReplayClient]",
  "[GoalOverlayUI]",
];

type Listener = (e: LifecycleEvent) => void;

const listeners = new Set<Listener>();
let recent: LifecycleEvent[] = [];
let counts: Record<string, number> = {};
let installed = false;

export function subscribeLifecycle(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function lifecycleSnapshot(): { counts: Record<string, number>; recent: LifecycleEvent[] } {
  return { counts: { ...counts }, recent: recent.slice(-10) };
}

export function installConsoleLifecycleHook(): void {
  if (installed) return;
  installed = true;
  for (const key of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[key].bind(console) as (...a: unknown[]) => void;
    console[key] = ((...a: unknown[]) => {
      orig(...a);
      try {
        sniff(a);
      } catch {
        /* 解析失败绝不影响 Unity 自身输出 */
      }
    }) as typeof console.log;
  }
}

/** 供自测/回放分析：直接喂一行日志 */
export function parseLifecycleLine(text: string, at = 0): LifecycleEvent | null {
  return parse(text, at);
}

function sniff(args: unknown[]): void {
  const head = typeof args[0] === "string" ? args[0] : "";
  if (!head) return;
  let hit = false;
  for (const t of INTERESTING) {
    if (head.indexOf(t) >= 0) {
      hit = true;
      break;
    }
  }
  if (!hit) return;
  const e = parse(head, performance.now());
  if (e) emit(e);
}

const mk = (
  kind: LifecycleKind,
  at: number,
  text: string,
  extra: Partial<LifecycleEvent> = {},
): LifecycleEvent => ({
  kind,
  at,
  frame: null,
  totalFrames: null,
  duration: null,
  text: text.slice(0, 160),
  ...extra,
});

function parse(head: string, at: number): LifecycleEvent | null {
  const ps = PLAYBACK_START_RE.exec(head);
  if (ps) {
    return mk("playback_start", at, head, {
      frame: Number(ps[1]),
      totalFrames: Number(ps[2]),
      duration: Number(ps[3]),
    });
  }
  const gs = GAMEPLAY_START_RE.exec(head);
  if (gs) return mk("gameplay_start", at, head, { frame: Number(gs[1]) });

  const cs = CEREMONY_START_RE.exec(head);
  if (cs) {
    return mk("ceremony_start", at, head, {
      ceremony: { name: "", skipped: false, waitMs: null, total: Number(cs[1]) },
    });
  }
  const cp = CEREMONY_PHASE_RE.exec(head);
  if (cp) {
    return mk("ceremony_phase", at, head, {
      ceremony: {
        name: cp[2].toUpperCase(),
        skipped: cp[1].toLowerCase() === "skipping",
        waitMs: cp[4] != null ? Number(cp[4]) : null,
        total: 0,
      },
    });
  }

  const gm = GOAL_RE.exec(head);
  if (gm) {
    return mk("goal", at, head, {
      goal: { side: gm[1], h: Number(gm[2]), a: Number(gm[3]) },
    });
  }
  const pc = PHASE_CHANGE_RE.exec(head);
  if (pc) return mk("phase_change", at, head, { phase: { from: pc[1], to: pc[2] } });

  if (USER_CLICK_RE.test(head)) return mk("user_click", at, head);
  if (MATCH_INFO_RE.test(head)) return mk("match_info", at, head);
  if (READY_RE.test(head)) return mk("ready_to_start", at, head);
  const d = DATA_RE.exec(head);
  if (d) return mk("data_ready", at, head, { totalFrames: Number(d[1]) });

  // GoalOverlayUI：进球庆祝视频（备援信号）
  if (GOAL_VIDEO_RE.test(head)) {
    const p = GOAL_VIDEO_PREP_RE.exec(head);
    return mk("goal_video", at, head, { detail: p ? p[1].split("/").pop() : "goal_anim" });
  }
  return null;
}

function emit(e: LifecycleEvent): void {
  counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  recent = [...recent, e].slice(-10);
  for (const fn of listeners) fn(e);
}

/** 该 phase 名是否表示"开球等待"（客户端日志用 FIRST_HALF / COUNTDOWN_TO_KICKOFF 等） */
export function isCountdownPhase(name: string | null | undefined): boolean {
  return !!name && /COUNTDOWN/i.test(name);
}

/** 客户端 phase 名 → 可读中文 */
export function phaseNameZh(name: string | null | undefined): string {
  if (!name) return "—";
  const m: Record<string, string> = {
    LOCKER_ROOM: "更衣室",
    OPENING_VIDEO: "开场视频",
    MATCHUP_REVEAL: "对阵揭晓",
    FORMATION_SELECTION: "阵型选择",
    KICK_OFF: "开球仪式",
    COUNTDOWN_TO_KICKOFF: "开球倒计时",
    FIRST_HALF: "上半场",
    SECOND_HALF: "下半场",
    COUNTDOWN_TO_END: "终场倒计时",
    GOLDEN_GOAL: "金球",
    POST_MATCH: "赛后",
  };
  return m[name] ?? name;
}

/**
 * 开场仪式各阶段「被触发 → 正式开球」的实测剩余时间（秒）。
 * 仅用于在仪式期给用户一个**进度预期**（面板此时拿不到帧号，只能报阶段）。
 * 实测（2026-10-01，59c9cce2，相对点击秒）：MATCHUP_REVEAL +3.36 / FORMATION_SELECTION
 * +15.37 / KICK_OFF +15.37 / COUNTDOWN_TO_KICKOFF +19.52 → `Ceremony complete` +24.53。
 */
const CEREMONY_REMAIN_SEC: Record<string, number> = {
  LOCKER_ROOM: 24.5,
  OPENING_VIDEO: 24.5,
  MATCHUP_REVEAL: 21.2,
  FORMATION_SELECTION: 9.2,
  KICK_OFF: 9.2,
  COUNTDOWN_TO_KICKOFF: 5.0,
};

/** 该仪式阶段通常还有多久正式开球（秒）；未知返回 null */
export function ceremonyRemainSec(name: string | null | undefined): number | null {
  if (!name) return null;
  return CEREMONY_REMAIN_SEC[name] ?? null;
}
