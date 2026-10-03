from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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


@app.get("/api/scheduler/status")
def scheduler_status():
    """调度器节拍状态：下次运行时间 / 上轮结束 / 是否执行中。"""
    return scheduler.status()


MIN_INTERVAL_S, MAX_INTERVAL_S = 60, 3600


class SchedulerConfigIn(BaseModel):
    enabled: bool | None = None
    interval_seconds: int | None = None


@app.get("/api/scheduler/config")
def get_scheduler_config():
    """调度器全局配置（启用开关 + 间隔）。"""
    return db.get_scheduler_config()


@app.post("/api/scheduler/config")
def set_scheduler_config(body: SchedulerConfigIn):
    """更新调度器配置（部分更新：只传需要改的字段），改库即热生效。"""
    if body.interval_seconds is not None and not (MIN_INTERVAL_S <= body.interval_seconds <= MAX_INTERVAL_S):
        raise HTTPException(400, f"interval_seconds 超出范围（{MIN_INTERVAL_S}~{MAX_INTERVAL_S} 秒）")
    return db.set_scheduler_config(enabled=body.enabled, interval_seconds=body.interval_seconds)


@app.post("/api/scheduler/run")
def scheduler_run():
    """手动立即执行一轮（拉数据 + 约练习赛），完成后下次运行时间从此刻起算。"""
    return scheduler.trigger_now()


@app.on_event("startup")
def _startup():
    scheduler.start()
