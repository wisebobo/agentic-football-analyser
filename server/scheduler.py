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


def _run_cycle_once() -> None:
    if not _cycle_lock.acquire(blocking=False):
        print("[scheduler] previous cycle still running, skip this one")
        return
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
    global _thread, _started
    if _started:
        return
    _thread = threading.Thread(target=_loop, name="agentic-football-scheduler", daemon=True)
    _thread.start()
    _started = True
    print(f"[scheduler] started, interval={INTERVAL_SECONDS}s")
