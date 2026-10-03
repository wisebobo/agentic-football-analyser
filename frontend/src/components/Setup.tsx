import { useEffect, useState } from "react";
import { api, DEFAULT_BASE_URL } from "../api";
import { useApp } from "../App";
import type { FetchRun, SchedulerConfig, SchedulerStatus, Tournament } from "../types";

// 练习赛对手：与后端 VALID_OPPONENTS 同序（轮换序）；label 中文短名
const OPPONENTS: { key: string; label: string }[] = [
  { key: "aggressive", label: "强攻" },
  { key: "balanced", label: "均衡" },
  { key: "defensive", label: "防守" },
];

export default function Setup({ tournament }: { tournament: Tournament }) {
  const { refresh, tournaments } = useApp();
  const [teamCode, setTeamCode] = useState("");
  const [tournamentId, setTournamentId] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);

  const [fetching, setFetching] = useState(false);
  const [force, setForce] = useState(false);
  const [runs, setRuns] = useState<FetchRun[]>([]);
  const [savingIds, setSavingIds] = useState<number[]>([]);
  // 调度器节拍状态：5s 轮询同步（失败静默保留旧值）+ 1s 本地 ticker 驱动倒计时
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  // 全局调度配置（存库热生效）：开关 + 间隔（UI 用分钟，1~60）
  const [cfg, setCfg] = useState<SchedulerConfig | null>(null);
  const [minInput, setMinInput] = useState("");
  const [runBusy, setRunBusy] = useState(false);

  const loadRuns = () => api.fetchRuns(tournament.id).then(setRuns).catch(() => {});
  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournament.id]);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.schedulerStatus().then((s) => { if (live) setSched(s); }).catch(() => {});
    load();
    const poll = setInterval(load, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(poll); clearInterval(tick); };
  }, []);

  // 初始化配置：间隔输入框与保存按钮的输入校验都以它为准
  useEffect(() => {
    api.schedulerConfig()
      .then((c) => { setCfg(c); setMinInput(String(Math.round(c.interval_seconds / 60))); })
      .catch(() => {});
  }, []);

  const create = async () => {
    setMsg("");
    setCreating(true);
    try {
      await api.createTournament({
        team_code: teamCode.trim(),
        tournament_id: tournamentId.trim(),
        base_url: baseUrl.trim() || DEFAULT_BASE_URL,
      });
      setTeamCode("");
      setTournamentId("");
      setMsg("赛事创建成功（配置不可变）");
      await refresh();
    } catch (e) {
      setMsg(`创建失败：${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const doFetch = async () => {
    setFetching(true);
    setMsg("");
    try {
      await api.fetchNow(tournament.id, force);
      await loadRuns();
      setMsg("拉取完成，详见日志");
    } catch (e) {
      setMsg(`拉取失败：${(e as Error).message}`);
    } finally {
      setFetching(false);
    }
  };

  const toggleAuto = async (t: Tournament, enabled: boolean) => {
    try {
      await api.toggleAuto(t.id, enabled);
      await refresh();
    } catch (e) {
      setMsg(`自动开关切换失败：${(e as Error).message}`);
    }
  };

  const toggleOpponents = async (t: Tournament, key: string, next: boolean) => {
    const cur = (t.practice_opponents || "").split(",").filter(Boolean);
    const list = next ? [...new Set([...cur, key])] : cur.filter((o) => o !== key);
    setMsg("");
    setSavingIds((s) => [...s, t.id]);
    try {
      await api.setOpponents(t.id, list);
      await refresh();
    } catch (e) {
      setMsg(`对手配置保存失败：${(e as Error).message}`);
    } finally {
      setSavingIds((s) => s.filter((x) => x !== t.id));
    }
  };

  /** 保存全局调度配置（部分字段）；成功后刷新配置与节拍状态 */
  const saveCfg = async (body: { enabled?: boolean; interval_seconds?: number }) => {
    const c = await api.schedulerSetConfig(body);
    setCfg(c);
    if (body.interval_seconds !== undefined) setMinInput(String(Math.round(c.interval_seconds / 60)));
    api.schedulerStatus().then(setSched).catch(() => {});
  };

  const toggleSched = async (enabled: boolean) => {
    setMsg("");
    try {
      await saveCfg({ enabled });
    } catch (e) {
      setMsg(`定时任务开关切换失败：${(e as Error).message}`);
    }
  };

  const saveInterval = async () => {
    const m = Number(minInput);
    if (!Number.isInteger(m) || m < 1 || m > 60) {
      setMsg("间隔须为 1~60 的整数（分钟）");
      return;
    }
    setMsg("");
    try {
      await saveCfg({ interval_seconds: m * 60 });
      setMsg("间隔已更新，下一轮起生效");
    } catch (e) {
      setMsg(`间隔保存失败：${(e as Error).message}`);
    }
  };

  const runNow = async () => {
    setMsg("");
    setRunBusy(true);
    try {
      const r = await api.schedulerRun();
      setMsg(r.ran
        ? "手动执行完成，下次运行时间已重新起算"
        : "上一轮尚未结束，本次跳过");
      await api.schedulerStatus().then(setSched).catch(() => {});
    } catch (e) {
      setMsg(`立即运行失败：${(e as Error).message}`);
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <div>
      <section className="card">
        <h2>创建赛事</h2>
        <p className="hint">
          输入 team code + tournament id + API base URL；系统将通过上游
          /tournaments/{"{id}"} 与 /teams/mine 校验并获取绑定的 team id。
          创建后配置不可变；同一 team code 不可重复创建。
        </p>
        <div className="row">
          <input placeholder="team code" value={teamCode} onChange={(e) => setTeamCode(e.target.value)} />
          <input placeholder="tournament id" value={tournamentId} onChange={(e) => setTournamentId(e.target.value)} />
          <input placeholder="API base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <button onClick={create} disabled={creating || !teamCode.trim() || !tournamentId.trim()}>
            {creating ? "校验中…" : "创建赛事"}
          </button>
        </div>
        {msg && <div className="hint">{msg}</div>}
      </section>

      <section className="card">
        <h2>已创建赛事（{tournaments.length}）</h2>
        {sched && (
          <p className="hint">
            {(() => {
              if (!cfg || !cfg.enabled) {
                return "定时任务 已关闭 —— 勾选下方「启用定时任务」后按间隔自动拉取数据并约练习赛";
              }
              const anyOn = tournaments.some((t) => t.auto_enabled);
              if (!anyOn) {
                return `定时任务已启用，但所有赛事「自动」均未勾选 —— 勾选下方任一「自动」后，每 ${Math.round(cfg.interval_seconds / 60)} 分钟自动拉取数据并约练习赛`;
              }
              const remain = Math.max(0, Math.round((sched.next_run_epoch * 1000 - now) / 1000));
              const cd = remain > 0 ? `（约 ${Math.ceil(remain / 60)} 分后）` : "（即将执行）";
              return `定时任务 每 ${Math.round(cfg.interval_seconds / 60)} 分钟 · 下次运行 ${sched.next_run_at ?? "…"}${cd}${sched.running ? " · 执行中…" : ""}`;
            })()}
          </p>
        )}
        {cfg && (
          <div className="row">
            <label>
              <input
                type="checkbox"
                checked={cfg.enabled}
                onChange={(e) => toggleSched(e.target.checked)}
              />{" "}
              启用定时任务
            </label>
            <label title="1~60 分钟，下一轮起生效">
              间隔
              <input
                type="number"
                min={1}
                max={60}
                value={minInput}
                onChange={(e) => setMinInput(e.target.value)}
                style={{ width: 64, margin: "0 4px" }}
              />
              分钟
              <button onClick={saveInterval} style={{ marginLeft: 6 }}>保存</button>
            </label>
            <button onClick={runNow} disabled={runBusy} className="btn-primary">
              {runBusy ? "执行中（同步，可能数分钟）…" : "立即运行"}
            </button>
          </div>
        )}
        <p className="hint">
          对手 = 该赛事练习赛可用的对手子集（按 强攻→均衡→防守 顺序轮换）；全部不勾 = 不自动约练习赛。
        </p>
        <table className="tbl">
          <thead>
            <tr><th>#</th><th>team code</th><th>队伍</th><th>赛事</th><th>创建时间</th><th>自动</th><th>对手</th></tr>
          </thead>
          <tbody>
            {tournaments.map((t) => (
              <tr key={t.id} className={t.id === tournament.id ? "row-mine" : ""}>
                <td>{t.id}</td>
                <td>{t.team_code}</td>
                <td>{t.team_name || "—"}</td>
                <td>{t.tournament_name || t.tournament_id}</td>
                <td>{t.created_at}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!t.auto_enabled}
                    onChange={(e) => toggleAuto(t, e.target.checked)}
                  />
                </td>
                <td>
                  {OPPONENTS.map((o) => {
                    const on = (t.practice_opponents || "").split(",").includes(o.key);
                    const saving = savingIds.includes(t.id);
                    return (
                      <label key={o.key} title={o.key} style={{ marginRight: 6, opacity: saving ? 0.5 : 1 }}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={saving}
                          onChange={() => toggleOpponents(t, o.key, !on)}
                        />{" "}
                        {o.label}
                      </label>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>手动拉取 · {tournament.tournament_name || tournament.tournament_id}</h2>
        <div className="row">
          <button onClick={doFetch} disabled={fetching} className="btn-primary">
            {fetching ? "拉取中（同步执行，可能数分钟）…" : "拉取数据"}
          </button>
          <label><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 强制重拉已结束比赛</label>
        </div>
        {runs.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>开始</th><th>结束</th><th>场数</th><th>新增</th>
                <th>刷新</th><th>跳过</th><th>失败</th><th>积分榜行数</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.started_at}</td>
                  <td>{r.finished_at}</td>
                  <td>{r.matches_seen}</td>
                  <td>{r.new_matches}</td>
                  <td>{r.refreshed}</td>
                  <td>{r.skipped}</td>
                  <td>{r.failed}</td>
                  <td>{r.leaderboard_rows}</td>
                  <td>
                    {r.incomplete ? "⚠ 不完整" : "✔"}
                    {r.error_text && <div className="hint">{r.error_text}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hint">暂无拉取日志</div>
        )}
      </section>
    </div>
  );
}
