/**
 * unity/unity-loader.ts — Unity WebGL 生命周期封装
 *
 * 动态加载 Unity loader script，封装 createUnityInstance 调用。
 * 切换比赛时由调用方通过 React key remount canvas 后重新 boot。
 */

export interface UnityInstance {
  SendMessage(obj: string, method: string, ...args: unknown[]): void;
  Quit(): Promise<void>;
  SetFullscreen(): void;
  [key: string]: unknown;
}

export interface BootConfig {
  canvas: HTMLCanvasElement;
  matchId: string;
  server: string;
  onProgress?: (pct: number) => void;
}

type CreateUnityInstance = (
  canvas: HTMLCanvasElement,
  config: Record<string, unknown>,
  onProgress?: (p: number) => void,
) => Promise<UnityInstance>;

const UNITY_FILES = {
  loader: "/unity/asw-agentic-soccer-web.loader.js",
  data: "/unity/asw-agentic-soccer-web.data",
  framework: "/unity/asw-agentic-soccer-web.framework.js",
  wasm: "/unity/asw-agentic-soccer-web.wasm",
  streamingAssets: "/unity/StreamingAssets",
};

let createFn: CreateUnityInstance | null = null;

function loadScript(): Promise<void> {
  if (createFn) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = UNITY_FILES.loader;
    s.onload = () => {
      const fn = (window as unknown as Record<string, unknown>).createUnityInstance;
      if (typeof fn !== "function") {
        reject(new Error("createUnityInstance not found after Unity loader script load"));
        return;
      }
      createFn = fn as CreateUnityInstance;
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load Unity loader script"));
    document.head.appendChild(s);
  });
}

/**
 * 客户端从页面 URL 读 matchId/server（参考页同款机制：boot 前写进地址栏）。
 * 本组件是 SPA tab，URL 默认无 query，客户端会读到空值 → "No server connection
 * (Check relay server address and match ID)"。保留原 pathname/hash，仅覆盖这两个参数。
 */
function writeUnityReplayUrl(matchId: string, server: string): void {
  const p = new URLSearchParams(window.location.search);
  p.set("matchId", matchId);
  p.set("server", server);
  const qs = p.toString();
  const url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", url);
}

/** 加载 Unity loader 并启动 WebGL 实例。 */
export async function bootUnity(cfg: BootConfig): Promise<UnityInstance> {
  await loadScript();
  writeUnityReplayUrl(cfg.matchId, cfg.server);
  const c = createFn!;
  return c(
    cfg.canvas,
    {
      dataUrl: UNITY_FILES.data,
      frameworkUrl: UNITY_FILES.framework,
      codeUrl: UNITY_FILES.wasm,
      streamingAssetsUrl: UNITY_FILES.streamingAssets,
      companyName: "AWSAgenticSoccer",
      productName: "asw-agentic-soccer-web",
      productVersion: "1.0",
      arguments: ["--matchId", cfg.matchId, "--server", cfg.server],
    },
    (p: number) => cfg.onProgress?.(p * 100),
  );
}

/** 销毁 Unity 实例（fire-and-forget）。 */
export function destroyUnity(inst: UnityInstance): void {
  inst.Quit?.();
}
