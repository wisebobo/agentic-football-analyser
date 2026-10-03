import { useEffect, useState } from "react";
import { api, DEFAULT_BASE_URL } from "../api";
import { useApp } from "../App";
import type { FetchRun, Tournament } from "../types";

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

  const loadRuns = () => api.fetchRuns(tournament.id).then(setRuns).catch(() => {});
  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournament.id]);

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
        <table className="tbl">
          <thead>
            <tr><th>#</th><th>team code</th><th>队伍</th><th>赛事</th><th>创建时间</th><th>自动</th></tr>
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
