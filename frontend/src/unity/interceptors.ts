/**
 * unity/interceptors.ts — Unity WebGL 客户端网络拦截
 *
 * Unity（WASM）运行在与本 React 应用相同的 JS 上下文里，它内部的
 * fetch / XMLHttpRequest / WebSocket 都会走到浏览器全局实现。
 * 参考 frontend/public/unity/index.html 的拦截逻辑，这里用 TypeScript
 * 重写成模块，在 Replay 组件 mount 时安装一次（幂等），从而：
 *
 *  1. replay/info 的 downloadUrl → 改写为本地 /unity/replays/{vendor_match_id}
 *     （后端本地缓存优先，离线可回放）
 *  2. CloudFront 远程资源（队徽等）→ 改写为 /unity/rproxy?u=...
 *     （后端代拉，绕过浏览器 CORS）
 */

// relay 服务（Unity 回放源站）
export const RELAY_BASE = "https://game.agentic-football.aws.dev";

// 拦截目标：所有 Unity 相关的网络请求都走 Vite proxy → FastAPI /unity
const RPROXY = "/unity/rproxy";

let installed = false;

/** 幂等安装 fetch / XHR / WebSocket 拦截。重复调用无副作用。 */
export function installUnityInterceptors(): void {
  if (installed) return;
  installed = true;

  installFetchIntercept();
  installXhrIntercept();
  installWsProbe();
}

// ---------- fetch 拦截 ----------

const REPLAY_INFO_RE = /^(https?:\/\/[^/]+)\/match\/([^/]+)\/replay\/info/;
const CLOUDFRONT_RE = /^https?:\/\/[^/]*cloudfront\.net\//i;

function rewriteReplayDownload(j: unknown, matchId: string): unknown {
  if (j && typeof j === "object" && (j as Record<string, unknown>).downloadUrl) {
    (j as Record<string, string>).downloadUrl = `/unity/replays/${matchId}`;
  }
  return j;
}

function installFetchIntercept(): void {
  const _fetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // 1) CloudFront 远程资源 → 本地 rproxy
    if (CLOUDFRONT_RE.test(url)) {
      const proxied = `${RPROXY}?u=${encodeURIComponent(url)}`;
      return _fetch(proxied, init);
    }

    // 2) replay/info → 改写 downloadUrl 到本地
    const m = REPLAY_INFO_RE.exec(url);
    if (m) {
      const r = await _fetch(m[0], init);
      if (!r.ok) return r;
      try {
        const j = await r.clone().json();
        rewriteReplayDownload(j, m[2]);
        return new Response(JSON.stringify(j), {
          status: r.status,
          statusText: r.statusText,
          headers: new Headers({ "Content-Type": "application/json" }),
        });
      } catch {
        return r;
      }
    }

    // 3) 其余原样
    return _fetch(input, init);
  }) as typeof window.fetch;
}

// ---------- XHR 拦截（UnityWebRequest 在 WebGL 上可能走 XHR）----------

function installXhrIntercept(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _open: (...a: unknown[]) => void = (XMLHttpRequest.prototype.open as any) as unknown as (...a: unknown[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _send: (...a: unknown[]) => void = (XMLHttpRequest.prototype.send as any) as unknown as (...a: unknown[]) => void;

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const url = String(args[1] ?? "");
    const tag = this as unknown as Record<string, unknown>;
    tag.__unityUrl = url;
    tag.__isReplayInfo = /\/match\/[^/]+\/replay\/info/.test(url);
    return _open.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    const self = this as unknown as Record<string, unknown>;
    if (self.__isReplayInfo) {
      this.addEventListener("load", function (this: XMLHttpRequest) {
        try {
          const m = REPLAY_INFO_RE.exec(String(self.__unityUrl ?? ""));
          const j: unknown = JSON.parse(this.responseText);
          if (m) rewriteReplayDownload(j, m[2]);
          const txt = JSON.stringify(j);
          Object.defineProperty(this, "responseText", { value: txt, configurable: true });
          Object.defineProperty(this, "response", { value: txt, configurable: true });
        } catch {
          /* 非 JSON 或解析失败则忽略 */
        }
      });
    }
    return _send.apply(this, args);
  };
}

// ---------- WebSocket 诊断探针（镜像参考页，仅打点、不改连接行为）----------
// Unity 用 Emscripten 的 _JsWebSocket → 底层就是 window.WebSocket。回放/连接
// 的成败只能在这里看到真实 URL 与关闭码，所以对 window.WebSocket 打点。

function installWsProbe(): void {
  const _WS = window.WebSocket;
  const WSProbe = function (
    this: WebSocket,
    url: string,
    protocols?: string | string[],
  ): WebSocket {
    const t0 = Date.now();
    const ws: WebSocket =
      protocols === undefined ? new _WS(url) : new _WS(url, protocols);
    const tag = `[ws] ${url}` + (protocols === undefined ? "" : ` sub=${JSON.stringify(protocols)}`);
    console.log(tag, "→ CONNECTING");
    ws.addEventListener("open", () =>
      console.log(tag, "→ OPEN ✓", Date.now() - t0 + "ms"));
    ws.addEventListener("error", () => console.log(tag, "→ ERROR ✗"));
    ws.addEventListener("close", (e: CloseEvent) => {
      console.log(
        tag, "→ CLOSE code=", e.code, "reason=", JSON.stringify(e.reason),
        "wasClean=", e.wasClean, Date.now() - t0 + "ms");
      if (e.code === 1006) {
        console.log("   ↑ 1006 = 握手被拒/网络不通（非服务端主动关闭），看 DevTools 的 WS 帧行。");
      }
    });
    return ws;
  } as unknown as typeof WebSocket;
  WSProbe.prototype = _WS.prototype;
  WSProbe.CONNECTING = _WS.CONNECTING;
  WSProbe.OPEN = _WS.OPEN;
  WSProbe.CLOSING = _WS.CLOSING;
  WSProbe.CLOSED = _WS.CLOSED;
  window.WebSocket = WSProbe;
}

