import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 确保 .wasm 以正确的 MIME 提供（否则 Unity 退化为非流式编译并报警告）。
function unityWasmMime() {
  return {
    name: "unity-wasm-mime",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.endsWith(".wasm")) {
          res.setHeader("Content-Type", "application/wasm");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), unityWasmMime()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
      // Unity 静态资源（/unity/*.wasm/.data/.js/StreamingAssets/index.html）由 Vite 从
      // frontend/public/unity/ 原生托管，不再代理到后端。
      // 这里只把数据类 API 代理到后端 8000：
      "/unity/matches": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/unity/replays": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/unity/rproxy": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
    // Unity WebGL 线程模式需要 SharedArrayBuffer，页面（顶层文档）必须带 COOP/COEP
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
