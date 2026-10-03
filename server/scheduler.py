"""
server/scheduler.py — 后台定时任务：按可配置间隔（scheduler_config 表）对所有
auto_enabled=1 的赛事执行「拉取数据 + 触发 1 次练习赛（轮换对手）」。
daemon 线程，随 uvicorn 进程启停。单条赛事失败不阻塞其他赛事、不阻塞下一轮；
上一轮未结束时本轮跳过。配置改库即热生效（每轮读库），无需重启。
"""
import threading
import time

import db
import fetch_service

_thread: threading.Thread | None = None
_started = False
_cycle_lock = threading.Lock()

# 节拍状态（供 status() 推导下次运行时间；调度线程单写，API 线程读，GIL 下安全）
_start_epoch: float = 0.0
_last_cycle_end: float | None = None
_running = False


def _fmt(ts: float | None) -> str | None:
    """epoch → 本地 'HH:MM:SS'。"""
    return None if ts is None else time.strftime("%H:%M:%S", time.localtime(ts))


def _interval_seconds() -> int:
    """当前配置间隔（每轮读库，热生效）。"""
    return db.get_scheduler_config()["interval_seconds"]


def status() -> dict:
    """返回调度器节拍状态：下次运行时间 / 上轮结束 / 是否正在执行 / 是否启用。

    next_run 推导：稳态 = 上轮结束 + 配置间隔；上轮尚未结束时 = 启动节拍 start_epoch + N*interval。
    """
    cfg = db.get_scheduler_config()
    interval = cfg["interval_seconds"]
    now = time.time()
    if _last_cycle_end is not None:
        next_run = _last_cycle_end + interval
    else:
        n = int((now - _start_epoch) // interval)
        next_run = _start_epoch + n * interval
        if next_run <= now:  # 首轮已跑完但还没写 last_cycle_end
            next_run += interval
    return {
        "enabled": cfg["enabled"],
        "interval_seconds": interval,
        "next_run_at": _fmt(next_run),
        "next_run_epoch": next_run,
        "last_cycle_end": _fmt(_last_cycle_end),
        "running": _running,
    }


def _run_cycle_once() -> None:
    """周期轮入口：加锁保护后执行一轮（锁被占则跳过并锚定节拍）。"""
    global _last_cycle_end, _running
    if not _cycle_lock.acquire(blocking=False):
        print("[scheduler] previous cycle still running, skip this one")
        _last_cycle_end = time.time()  # skip 分支同样重置节拍锚点
        return
    try:
        _do_cycle()
    finally:
        _cycle_lock.release()
        _running = False
        _last_cycle_end = time.time()


def _do_cycle() -> None:
    """真正的一轮（调用方必须已持有 _cycle_lock）。"""
    global _running
    _running = True
    if not db.get_scheduler_config()["enabled"]:
        print("[scheduler] disabled, skip cycle")
        return
    print("[scheduler] cycle start")
    enabled = [t for t in db.list_tournaments() if t.get("auto_enabled")]
    for t in enabled:
        lid = t["id"]
        try:
            fetch_service.fetch_tournament(lid)
            print(f"[scheduler] fetch ok: tournament {lid} ({t['team_code']})")
        except Exception as e:
            print(f"[scheduler] fetch failed: tournament {lid}: {e}")
        try:
            r = fetch_service.trigger_practice_match(lid)
            if r["ok"]:
                print(f"[scheduler] practice ok: tournament {lid} opponent={r['opponent']}")
            elif r.get("err") == "no opponents selected":
                print(f"[scheduler] practice skipped (no opponents selected): tournament {lid}")
            else:
                print(f"[scheduler] practice failed: tournament {lid} "
                      f"opponent={r['opponent']} err={r['err']}")
        except Exception as e:
            print(f"[scheduler] practice failed: tournament {lid}: {e}")
    print("[scheduler] cycle end")


def _loop() -> None:
    while True:
        try:
            _run_cycle_once()
        except Exception as e:
            # 理论不应该发生（_run_cycle_once 内部已逐条 try/except），兜底防止线程意外退出
            print(f"[scheduler] unexpected error in cycle: {e}")
        time.sleep(_interval_seconds())


def trigger_now() -> dict:
    """主线程立即执行一轮（用户手动「立即运行」）。

    阻塞等待完成；与周期轮共用 _cycle_lock 防叠加（上一轮未结束则跳过）。
    执行后 _last_cycle_end 更新，status().next_run_at 自动重新起算。
    """
    global _last_cycle_end, _running
    if not _cycle_lock.acquire(blocking=False):
        print("[scheduler] manual trigger skipped: previous cycle still running")
        _last_cycle_end = time.time()
        return {"ran": False}
    try:
        print("[scheduler] manual trigger")
        _do_cycle()
        return {"ran": True, "next": status()}
    finally:
        _cycle_lock.release()
        _running = False
        _last_cycle_end = time.time()


def start() -> None:
    """FastAPI startup 事件调用；幂等，重复调用不会启动第二个线程。"""
    global _thread, _started, _start_epoch
    if _started:
        return
    _start_epoch = time.time()
    _thread = threading.Thread(target=_loop, name="agentic-football-scheduler", daemon=True)
    _thread.start()
    _started = True
    cfg = db.get_scheduler_config()
    print(f"[scheduler] started, enabled={cfg['enabled']}, interval={cfg['interval_seconds']}s")
