/**
 * unity/playback-watch.ts — 纯浏览器侧的播放观测（不依赖 Unity 的日志）。
 *
 * 为什么需要（实测）：
 *  - client 日志是**最精确**的锚点来源，但属于「第三方实现的字符串」，会随客户端构建变化；
 *    这里提供两路独立备援，避免日志一改面板就彻底失灵。
 *  - 回放必须由用户在画面里点 **START 按钮**（画布 50% × 82%）才开始。
 *
 * 三类信号：
 *   pointerdown     canvas 上的指针按下（只作"有人交互"的提示，**不作为开播锚点**：
 *                   点在球场任意处也会触发，据此对齐会假同步）
 *   pitch           画面出现**大片绿茵**（实测：START/仪式 ≈14~16%，比赛画面 30~45%）
 *                   ⇒ 这就是"开球了"的视觉时刻，配 kickoff_frame 即成精确锚点
 *   goal_video      进球庆祝视频（goal_anim_4K.mp4）开始播放 ⇒ 每次进球的 DOM 级信号
 *
 * 采样方式：canvas.captureStream(4) → <video> → 缩到 48×27 的 2D canvas 读像素。
 * 用 captureStream 而不是 drawImage(canvas)，因为 Unity WebGL 通常不开
 * preserveDrawingBuffer，直接 drawImage 会拿到空白帧。
 */

export type PlaybackSignalKind = "pointerdown" | "content_change" | "pitch" | "goal_video";

export interface PlaybackSignal {
  kind: PlaybackSignalKind;
  /** performance.now() */
  at: number;
  detail?: string;
}

type Listener = (s: PlaybackSignal) => void;

const listeners = new Set<Listener>();
let counts: Record<PlaybackSignalKind, number> = {
  pointerdown: 0,
  content_change: 0,
  pitch: 0,
  goal_video: 0,
};
let lastBrightness: number | null = null;
let lastGreen: number | null = null;
let baseline: number | null = null;
let samplerState: "off" | "ok" | "unavailable" | "error" = "off";
let videoHookInstalled = false;

export function subscribePlayback(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function playbackSnapshot(): {
  counts: Record<PlaybackSignalKind, number>;
  brightness: number | null;
  green: number | null;
  baseline: number | null;
  sampler: string;
} {
  return {
    counts: { ...counts },
    brightness: lastBrightness,
    green: lastGreen,
    baseline,
    sampler: samplerState,
  };
}

/** 供自测重置（正常流程不需要） */
export function _resetPlaybackWatchForTest(): void {
  counts = { pointerdown: 0, content_change: 0, pitch: 0, goal_video: 0 };
  listeners.clear();
  lastBrightness = null;
  lastGreen = null;
  baseline = null;
  samplerState = "off";
}

function emit(s: PlaybackSignal): void {
  counts[s.kind] += 1;
  for (const fn of listeners) fn(s);
}

/** 进球庆祝视频观测：Unity 用 <video> 播 goal_anim_*.mp4（幂等） */
function installVideoHook(): void {
  if (videoHookInstalled) return;
  videoHookInstalled = true;
  try {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function patchedPlay(this: HTMLMediaElement) {
      try {
        const src = this.currentSrc || this.src || "";
        const name = src.split("?")[0].split("/").pop() || "";
        if (name && /goal|anim|celebration/i.test(name)) {
          emit({ kind: "goal_video", at: performance.now(), detail: name });
        }
      } catch {
        /* 观测失败不影响播放 */
      }
      return orig.apply(this);
    };
  } catch {
    /* 原型不可写则放弃 */
  }
}

/** 绿茵占比阈值：START/仪式 ~0.14-0.16，比赛画面 0.30-0.45 */
const GREEN_ABS = 0.26;
const GREEN_REL = 0.09;

export function installPlaybackWatch(canvas: HTMLCanvasElement): () => void {
  installVideoHook();
  const cleanups: Array<() => void> = [];

  // ---- 1) 指针按下（仅提示，不作锚点）----
  const onDown = () => {
    try {
      emit({ kind: "pointerdown", at: performance.now() });
    } catch {
      /* ignore */
    }
  };
  canvas.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  cleanups.push(() => canvas.removeEventListener("pointerdown", onDown, { capture: true }));

  // ---- 2) 画面采样：亮度 + 绿茵占比 ----
  let raf = 0;
  let stopped = false;
  const samples: number[] = [];
  let changed = false;
  let pitched = false;
  let pitchStreak = 0;
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let ctx2d: CanvasRenderingContext2D | null = null;
  let small: HTMLCanvasElement | null = null;
  let lastSampleAt = 0;

  const startSampler = (): boolean => {
    try {
      const anyCanvas = canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
      if (typeof anyCanvas.captureStream !== "function") {
        samplerState = "unavailable";
        return false;
      }
      stream = anyCanvas.captureStream(4);
      if (!stream || !stream.getVideoTracks().length) {
        samplerState = "unavailable";
        return false;
      }
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      void video.play().catch(() => undefined);
      small = document.createElement("canvas");
      small.width = 48;
      small.height = 27;
      ctx2d = small.getContext("2d", { willReadFrequently: true });
      samplerState = ctx2d ? "ok" : "unavailable";
      return !!ctx2d;
    } catch {
      samplerState = "error";
      return false;
    }
  };

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    if (video && ctx2d && now - lastSampleAt > 250) {
      lastSampleAt = now;
      try {
        ctx2d.drawImage(video, 0, 0, 48, 27);
        const d = ctx2d.getImageData(0, 0, 48, 27).data;
        let sum = 0;
        let green = 0;
        const n = 48 * 27;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          sum += (r + g + b) / 3;
          if (g > r + 12 && g > b + 12) green += 1;
        }
        const mean = sum / n;
        const gr = green / n;
        lastBrightness = mean;
        lastGreen = gr;

        if (samples.length < 6) {
          samples.push(gr);
          if (samples.length === 6) {
            const sorted = [...samples].sort((a, b) => a - b);
            baseline = (sorted[2] + sorted[3]) / 2;
          }
        } else {
          // 亮度突变（仪式切镜头）——仅诊断
          if (!changed && baseline != null && Math.abs(gr - baseline) > 0.35) {
            changed = true;
            emit({ kind: "content_change", at: now, detail: `Δgreen${(gr - baseline).toFixed(2)}` });
          }
          // ⭐ 绿茵出现 = 开球
          if (!pitched && baseline != null) {
            const need = Math.max(GREEN_ABS, baseline + GREEN_REL);
            if (gr >= need) {
              pitchStreak += 1;
              if (pitchStreak >= 2) {
                pitched = true;
                emit({ kind: "pitch", at: now, detail: `green=${(gr * 100).toFixed(0)}%` });
              }
            } else {
              pitchStreak = 0;
            }
          }
        }
      } catch {
        /* 采样失败忽略（例如流还没出帧） */
      }
    }
    raf = requestAnimationFrame(tick);
  };

  if (startSampler()) raf = requestAnimationFrame(tick);
  cleanups.push(() => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      if (video) video.srcObject = null;
    } catch {
      /* ignore */
    }
    video = null;
    small = null;
    ctx2d = null;
  });

  return () => cleanups.forEach((fn) => fn());
}
