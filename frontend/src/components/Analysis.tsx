import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  ScatterChart, Scatter, ReferenceLine,
} from "recharts";
import { api } from "../api";
import type { MatchFull, MatchRow, Tournament } from "../types";

// Sportscast 图表配色
const C = {
  grid: "#1b2b34",
  tick: "#7f95a3",
  tooltip: { background: "#101c23", border: "1px solid #1b2b34", borderRadius: 0, color: "#e9f3f4" } as const,
  home: "#3fb6ff",
  away: "#ff4d6d",
  goal: "#ffc832",
  agent: "#a78bfa",
  ok: "#2fe07f",
};

const fmtTime = (s: number | null) =>
  s == null ? "--" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const fmtMatchTime = (iso: string | null) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
};

export default function Analysis({ tournament }: { tournament: Tournament }) {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [mid, setMid] = useState<string>("");
  const [data, setData] = useState<MatchFull | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.matches(tournament.id).then(setMatches).catch((e) => setErr((e as Error).message));
  }, [tournament.id]);

  useEffect(() => {
    if (!mid) return;
    setErr("");
    setData(null);
    api.matchFull(mid).then(setData).catch((e) => setErr((e as Error).message));
  }, [mid]);

  const cmdData = useMemo(() => {
    if (!data) return [];
    const all = new Set([...Object.keys(data.command_breakdown.home), ...Object.keys(data.command_breakdown.away)]);
    return [...all].map((k) => ({
      cmd: k,
      主场: data.command_breakdown.home[k] || 0,
      客场: data.command_breakdown.away[k] || 0,
    }));
  }, [data]);

  const agentData = useMemo(() => {
    if (!data) return [];
    return data.agent_stats.map((a) => ({
      name: `${a.team}${a.position}`,
      平均延迟ms: a.latency_avg_ms ?? 0,
      成功率: a.success_rate == null ? 0 : Math.round(a.success_rate * 100),
    }));
  }, [data]);

  const goalData = useMemo(() => {
    if (!data) return [];
    return data.goals.map((g) => ({
      x: (g.game_time_secs ?? 0) / 60,
      y: g.team === "home" ? "主场" : "客场",
      label: `${g.position ?? "?"} ${g.agent_name ?? ""}`,
    }));
  }, [data]);

  return (
    <div className="card">
      <div className="row gap">
        <label className="sel-wrap">比赛：
          <select value={mid} onChange={(e) => setMid(e.target.value)} disabled={!matches.length}>
            <option value="">{matches.length ? "选择一场比赛…" : "暂无比赛数据（请先拉取）"}</option>
            {matches.map((m) => (
              <option key={m.match_id} value={m.match_id}>
                {m.is_practice ? "[练习赛] " : ""}{m.home_team_name} {m.home_score} - {m.away_score} {m.away_team_name} · {fmtMatchTime(m.starting_at)}
              </option>
            ))}
          </select>
        </label>
        {err && <span className="msg err">{err}</span>}
      </div>

      {data && (
        <>
          <div className="card-head">
            <h3>{data.home_team_name} {data.home_score} - {data.away_score} {data.away_team_name}</h3>
            <span className="sub">
              {data.mvp_agent_name ? `MVP ${data.mvp_agent_name}` : ""}
              {data.is_practice ? " · 练习赛" : ""}
              {data.starting_at ? ` · ${fmtMatchTime(data.starting_at)}` : ""}
              {data.status ? ` · ${data.status}` : ""} · 时长 {fmtTime(data.match_duration_seconds)}
              · tick {data.tick_count}
            </span>
          </div>

          {data.goals.length > 0 && (
            <div className="chart-box">
              <h4>进球时间轴</h4>
              <div style={{ width: "100%", height: 140 }}>
                <ScatterChart width="100%" height={140} margin={{ left: 30, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis type="number" dataKey="x" tick={{ fill: C.tick, fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v * 60)}s`} domain={[0, "dataMax"]} />
                  <YAxis type="category" dataKey="y" tick={{ fill: C.tick, fontSize: 11 }} />
                  <Tooltip
                    formatter={(_, name, p: any) => [`${(p.payload.x * 60) | 0}s ${p.payload.label}`, String(name)]}
                    contentStyle={C.tooltip}
                  />
                  <ReferenceLine x={0} stroke="#35505c" />
                  <Scatter data={goalData} fill={C.goal} />
                </ScatterChart>
              </div>
              <ul className="goals-list">
                {data.goals.map((g, i) => (
                  <li key={i}>
                    <b>{fmtTime(g.game_time_secs)}</b> {g.team === "home" ? data.home_team_name : data.away_team_name}
                    {" "}· {g.position} · {g.agent_name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="chart-box">
            <h4>双方指令分布</h4>
            {cmdData.length ? (
              <div style={{ width: "100%", height: 260 }}>
                <BarChart width="100%" height={260} data={cmdData} margin={{ left: 20, right: 16, top: 8 }}>
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

          <div className="chart-box">
            <h4>Agent 延迟 / 成功率</h4>
            {agentData.length ? (
              <div style={{ width: "100%", height: 260 }}>
                <BarChart width="100%" height={260} data={agentData} margin={{ left: 20, right: 16, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="name" tick={{ fill: C.tick, fontSize: 11 }} />
                  <YAxis tick={{ fill: C.tick, fontSize: 11 }} />
                  <Tooltip contentStyle={C.tooltip} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="平均延迟ms" fill={C.agent} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="成功率" fill={C.ok} radius={[2, 2, 0, 0]} />
                </BarChart>
              </div>
            ) : <div className="sub">暂无 agent 统计（上游 /report 未返回或保留期已过）</div>}
          </div>

          {data.ticks.length > 0 && (
            <div className="chart-box">
              <h4>Tick 响应（每 tick 一条）</h4>
              <div className="sub">
                共 {data.ticks.length} 条；延迟 {data.ticks.reduce((a, b) => a + (b.response_time ?? 0), 0).toFixed(0)}ms 累计，
                成功率 {data.ticks.length ? Math.round(
                  data.ticks.filter((t) => t.success).length / data.ticks.length * 100
                ) : 0}%
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
