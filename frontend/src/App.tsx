import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";
import type { Tournament } from "./types";
import Analysis from "./components/Analysis";
import Stats from "./components/Stats";
import Replay from "./components/Replay";
import Leaderboard from "./components/Leaderboard";
import Setup from "./components/Setup";

interface Ctx {
  tournaments: Tournament[];
  current: Tournament | null;
  setCurrent: (id: number) => void;
  refresh: () => void;
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const TABS = ["赛事配置", "赛事排行", "赛事重播", "比赛分析", "数据统计"] as const;

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="utc-clock">
      <span className="pulse-dot" />
      <span>
        <b>{now.toISOString().slice(11, 19)}</b> UTC
      </span>
    </div>
  );
}

function App() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [tab, setTab] = useState(0);

  const refresh = () => {
    api.listTournaments().then((ts) => {
      setTournaments(ts);
      setCurrentId((prev) => {
        if (prev != null && ts.some((t) => t.id === prev)) return prev;
        return ts.length ? ts[0].id : null;
      });
    }).catch(() => { /* 后端未启动 */ });
  };

  useEffect(refresh, []);

  const current = tournaments.find((t) => t.id === currentId) ?? null;

  useEffect(() => {
    if (currentId == null && tournaments.length) setCurrentId(tournaments[0].id);
  }, [tournaments, currentId]);

  return (
    <AppCtx.Provider value={{ tournaments, current, setCurrent: setCurrentId, refresh }}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">AF</span>
            <div className="brand-text">
              <span className="brand-title">Agentic Football</span>
              <span className="brand-sub">Match Intel Console</span>
            </div>
          </div>
          <label className="sel-wrap">
            赛事
            <select
              value={currentId ?? ""}
              onChange={(e) => setCurrentId(Number(e.target.value))}
              disabled={!tournaments.length}
            >
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.tournament_name || t.tournament_id}（{t.team_name || "未知队伍"}）
                </option>
              ))}
            </select>
          </label>
          <UtcClock />
          <nav>
            {TABS.map((name, i) => (
              <button key={name} className={i === tab ? "tab active" : "tab"} onClick={() => setTab(i)}>
                <span className="tab-num">{String(i + 1).padStart(2, "0")}</span>
                {name}
              </button>
            ))}
          </nav>
        </header>
        <main key={current?.id ?? -1} className={tab === 2 ? "wide" : undefined}>
          {tournaments.length === 0 ? (
            <div className="empty">尚未创建赛事 · 请先到 01 赛事配置 创建</div>
          ) : current ? (
            [
              <Setup key="u" tournament={current} />,
              <Leaderboard key="l" tournament={current} />,
              <Replay key="r" tournament={current} />,
              <Analysis key="a" tournament={current} />,
              <Stats key="s" tournament={current} />,
            ][tab]
          ) : null}
        </main>
      </div>
    </AppCtx.Provider>
  );
}

export default App;
