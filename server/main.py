from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db
import scheduler
from routers import tournaments, fetch, analytics, unity

app = FastAPI(title="Agentic Football", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
db.init_db()

app.include_router(tournaments.router, prefix="/api/tournaments", tags=["tournaments"])
app.include_router(fetch.router, prefix="/api/tournaments", tags=["fetch"])
app.include_router(analytics.router, prefix="/api", tags=["analytics"])

# Unity 回放 API（/unity/matches、/unity/replays/{id}、/unity/rproxy）。
# 注意：Unity 静态资源（.wasm/.data/.framework.js/loader.js/StreamingAssets/index.html）
# 不再由后端挂载，改由前端 Vite 从 frontend/public/unity/ 原生托管（dev 期）或拷贝进
# dist/unity/（build 期）。后端只负责数据类 API + 回放二进制缓存，不再耦合 tools/ 下的构建产物。
app.include_router(unity.router, tags=["unity"])


@app.get("/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def _startup():
    scheduler.start()
