"""
server/scheduler.py — 后台定时任务：每 300s 对所有 auto_enabled=1 的赛事
执行「拉取数据 + 触发 1 次练习赛（轮换对手）」。daemon 线程，随 uvicorn 进程启停。
单条赛事失败不阻塞其他赛事、不阻塞下一轮；上一轮未结束时本轮跳过。
"""
import threading
import time

import db
import fetch_service

INTERVAL_SECONDS = 300

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


def status() -> dict:
    """返回调度器节拍状态：下次运行时间 / 上轮结束 / 是否正在执行。

    next_run 推导：稳态 = 上轮结束 + 300；上轮尚未结束时 = 启动节拍 start_epoch + N*300。
    """
    now = time.time()
    if _last_cycle_end is not None:
        next_run = _last_cycle_end + INTERVAL_SECONDS
    else:
        n = int((now - _start_epoch) // INTERVAL_SECONDS)
        next_run = _start_epoch + n * INTERVAL_SECONDS
        if next_run <= now:  # 首轮已跑完但还没写 last_cycle_end
            next_run += INTERVAL_SECONDS
    return {
        "interval_seconds": INTERVAL_SECONDS,
        "next_run_at": _fmt(next_run),
        "next_run_epoch": next_run,
        "last_cycle_end": _fmt(_last_cycle_end),
        "running": _running,
    }


def _run_cycle_once() -> None:
    global _last_cycle_end, _running
    if not _cycle_lock.acquire(blocking=False):
        print("[scheduler] previous cycle still running, skip this one")
        _last_cycle_end = time.time()  # skip 分支同样重置节拍锚点
        return
    _running = True
    try:
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
    finally:
        _cycle_lock.release()
        _running = False
        _last_cycle_end = time.time()


def _loop() -> None:
    while True:
        try:
            _run_cycle_once()
        except Exception as e:
            # 理论不应该发生（_run_cycle_once 内部已逐条 try/except），兜底防止线程意外退出
            print(f"[scheduler] unexpected error in cycle: {e}")
        time.sleep(INTERVAL_SECONDS)


def start() -> None:
    """FastAPI startup 事件调用；幂等，重复调用不会启动第二个线程。"""
    global _thread, _started, _start_epoch
    if _started:
        return
    _start_epoch = time.time()
    _thread = threading.Thread(target=_loop, name="agentic-football-scheduler", daemon=True)
    _thread.start()
    _started = True
    print(f"[scheduler] started, interval={INTERVAL_SECONDS}s")
