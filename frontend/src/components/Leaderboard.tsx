import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { LeaderboardRow, Tournament } from "../types";

const RANK_CLS: Record<number, string> = { 1: "rank-1", 2: "rank-2", 3: "rank-3" };

export default function Leaderboard({ tournament }: { tournament: Tournament }) {
  const [snap, setSnap] = useState<{ fetched_at: string; rows: LeaderboardRow[] } | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    setErr(""); setSnap(null);
    api.leaderboard(tournament.id)
      .then((r) => setSnap(r.snapshot))
      .catch((e) => setErr((e as Error).message));
  }, [tournament.id]);

  const rows = useMemo(() => {
    if (!snap) return [];
    const all = snap.rows.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    if (!q.trim()) return all.slice(0, 100);
    const s = q.trim().toLowerCase();
    const hit = all.filter((r) =>
      (r.team_name ?? "").toLowerCase().includes(s) || (r.coach_name ?? "").toLowerCase().includes(s));
    return hit.slice(0, 200);
  }, [snap, q]);

  return (
    <div className="card">
      <div className="card-head">
        <h3>赛事排行榜</h3>
        <span className="sub">
          {snap
            ? `快照 ${new Date(snap.fetched_at).toLocaleString("zh-CN")} · 共 ${snap.rows.length} 队`
            : "尚无快照（请先在 ⑤ 赛事配置 中拉取）"}
        </span>
      </div>

      {err && <span className="msg err">{err}</span>}

      {snap && (
        <>
          <div className="row gap">
            <input
              className="search"
              placeholder="搜索队伍 / 教练（默认前 100 名，搜索上限 200）"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <table className="lb">
            <thead>
              <tr>
                <th>排名</th><th>队伍</th><th>教练</th><th>赛</th><th>胜</th><th>平</th><th>负</th>
                <th>进</th><th>失</th><th>净胜</th><th>积分</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rank = r.rank;
                const ours = r.team_id === tournament.team_id;
                return (
                  <tr key={r.team_id} className={ours ? "ours" : RANK_CLS[rank ?? -1] ?? ""}>
                    <td className={RANK_CLS[rank ?? -1] ?? ""}>{rank}</td>
                    <td>
                      {r.icon_url ? <img src={r.icon_url} alt="" /> : null}
                      {r.team_name}
                      {ours && <span className="badge">我方</span>}
                    </td>
                    <td>{r.coach_name ?? "—"}</td>
                    <td>{r.matches_played}</td>
                    <td>{r.wins}</td>
                    <td>{r.draws}</td>
                    <td>{r.losses}</td>
                    <td>{r.goals_scored}</td>
                    <td>{r.goals_conceded}</td>
                    <td>{r.goal_difference}</td>
                    <td className="pts">{r.points}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={11} className="sub">无匹配结果</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
