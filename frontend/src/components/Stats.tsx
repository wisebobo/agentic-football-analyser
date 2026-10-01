import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  BarChart, Bar,
} from "recharts";
import { api } from "../api";
import type { Stats, Tournament } from "../types";

const fmtMatchTime = (iso: string | null) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
};

// Sportscast 图表配色
const C = {
  grid: "#1b2b34",
  tick: "#7f95a3",
  tooltip: { background: "#101c23", border: "1px solid #1b2b34", borderRadius: 0, color: "#e9f3f4" } as const,
  home: "#3fb6ff",
  away: "#ff4d6d",
};

export default function StatsTab({ tournament }: { tournament: Tournament }) {
  const [data, setData] = useState<Stats | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setErr("");
    setData(null);
    api.stats(tournament.id).then(setData).catch((e) => setErr((e as Error).message));
  }, [tournament.id]);

  const cmdData = useMemo(() => {
    if (!data) return [];
    const home = data.command_breakdown.home;
    const away = data.command_breakdown.away;
    const all = new Set([...Object.keys(home), ...Object.keys(away)]);
    return [...all].map((k) => ({ cmd: k, 主场: home[k] || 0, 客场: away[k] || 0 }));
  }, [data]);

  const seriesData = useMemo(() => {
    if (!data) return [];
    return data.series.map((s, i) => ({
      name: `${i + 1}`,
      我方: s.we ?? 0,
      对方: s.op ?? 0,
      场次: s.our_side ? `${s.home ?? "?"} vs ${s.away ?? "?"}` : "（未知主客）",
    }));
  }, [data]);

  const agentRows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.agent_agg).flatMap(([team, pos]) =>
      Object.entries(pos).map(([p, v]) => ({ team, p, ...v })),
    );
  }, [data]);

  if (err) return <div className="card"><span className="msg err">{err}</span></div>;
  if (!data) return <div className="card sub">加载中…</div>;

  return (
    <div className="card">
      <div className="card-head"><h3>跨场统计（{data.total} 场，已知主客 {data.known_side} 场）</h3></div>

      <div className="stat-cards">
        <div className="stat-card"><div className="num win">{data.wins}</div><div>胜</div></div>
        <div className="stat-card"><div className="num">{data.draws}</div><div>平</div></div>
        <div className="stat-card"><div className="num lose">{data.losses}</div><div>负</div></div>
        <div className="stat-card">
          <div className="num">{data.possession.home?.toFixed?.(0) ?? data.possession.home}%</div><div>主场控球均值</div>
        </div>
        <div className="stat-card">
          <div className="num">{data.shots.home.shots} / {data.shots.home.sot}</div><div>主场射门 / 射正</div>
        </div>
        <div className="stat-card">
          <div className="num">{data.shots.away.shots} / {data.shots.away.sot}</div><div>客场射门 / 射正</div>
        </div>
      </div>

      <div className="chart-box">
        <h4>逐场比分（我方 vs 对方）</h4>
        {seriesData.length ? (
          <div style={{ width: "100%", height: 240 }}>
            <LineChart width="100%" height={240} data={seriesData} margin={{ left: 20, right: 16, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="name" tick={{ fill: C.tick, fontSize: 11 }} />
              <YAxis tick={{ fill: C.tick, fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                contentStyle={C.tooltip}
                labelFormatter={(_, p: any) => p?.[0]?.payload?.场次 ?? ""}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line dataKey="我方" stroke={C.home} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line dataKey="对方" stroke={C.away} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </div>
        ) : <div className="sub">暂无数据</div>}
      </div>

      <div className="chart-box">
        <h4>指令分布（全赛事累计）</h4>
        {cmdData.length ? (
          <div style={{ width: "100%", height: 220 }}>
            <BarChart width="100%" height={220} data={cmdData} margin={{ left: 20, right: 16, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="cmd" tick={{ fill: C.tick, fontSize: 11 }} />
              <YAxis tick={{ fill: C.tick, fontSize: 11 }} />
              <Tooltip contentStyle={C.tooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="主场" fill={C.home} radius={[2, 2, 0, 0]} />
              <Bar dataKey="客场" fill={C.away} radius={[2, 2, 0, 0]} />
            </BarChart>
          </div>
        ) : <div className="sub">暂无指令数据</div>}
      </div>

      {agentRows.length > 0 && (
        <div className="chart-box">
          <h4>Agent 聚合（按队 / 位置）</h4>
          <table>
            <thead><tr><th>队</th><th>位置</th><th>平均延迟(ms)</th><th>成功率</th></tr></thead>
            <tbody>
              {agentRows.map((r) => (
                <tr key={r.team + r.p}>
                  <td>{r.team}</td><td>{r.p}</td><td>{r.latency}</td>
                  <td>{Math.round(r.success * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="chart-box">
        <h4>比赛明细</h4>
        <table>
          <thead><tr><th>对阵</th><th>比分</th><th>主客</th><th>类型</th><th>开赛时间</th><th>时长(s)</th></tr></thead>
          <tbody>
            {data.matches.map((m) => (
              <tr key={m.match_id}>
                <td>{m.home ?? "?"} vs {m.away ?? "?"}</td>
                <td>{m.home_score} - {m.away_score}</td>
                <td>{m.our_side ? (m.our_side === "home" ? "我主" : "我客") : "—"}</td>
                <td>{m.is_practice ? "练习赛" : "正式赛"}</td>
                <td>{fmtMatchTime(m.starting_at)}</td>
                <td>{m.duration ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
