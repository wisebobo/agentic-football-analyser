import { useMemo, useState } from "react";
import type { ReplayData, ReplayTick, GoalRow } from "../types";

interface Shot {
  idx: number;
  gameTime: number | null;
  team: number;
  pid: number | null;
  pos: string;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  inBox: boolean;
  agentName: string | null;
  /** 射门→进球 中间各含球 tick 的球位置（世界尺度）；用于描真实路径 */
  trail: { x: number; z: number }[];
}

const POS_NAMES: Record<number, string> = { 0: "GK", 1: "DF", 2: "MF", 3: "MF", 4: "FW" };
/* 禁区深度：球门线 |x|=55 往内 17 单位 → 禁区边界 |x|=38 */
const BOX_X = 38;
const LOOKBACK = 200;

/**
 * 起射点：用「进球方 SHOOT 命令的 agent 站位」倒推，方向无关。
 * 进球方 = team。回溯该队最近的 SHOOT 命令拿到 shooterPid，再取其站位——
 * 持球 agent 在 db 层被钉到球上，射门后仍停留在原地（近射在对方禁区、
 * 吊射/远射时可能在自家禁区），比假设固定禁区可靠得多。
 * 无 SHOOT 命中时退化为「该队站在对方门侧禁区」的球员，再退 prev.ball。
 */
function findShotStart(
  ticks: ReplayTick[], goalIdx: number, prev: ReplayTick,
  team: number, isHomeGoal: boolean, goalZ: number,
): { x: number; z: number; inBox: boolean; pid: number | null; tick: number } {
  // 1) 回溯该队最近一条 SHOOT 命令 → shooterPid + 所在 tick
  let shooterPid: number | null = null;
  let shooterTick = -1;
  for (let j = goalIdx - 1; j >= Math.max(0, goalIdx - LOOKBACK); j--) {
    for (const c of ticks[j].cmds ?? []) {
      if (c.cmd === "SHOOT" && c.team === team && c.pid != null) {
        shooterPid = c.pid;
        shooterTick = j;
        break;
      }
    }
    if (shooterPid != null) break;
  }
  // 2) 取 shooterPid 在射门 tick（及更早）的真实站位（跳过默认 (0,0)）
  if (shooterPid != null) {
    for (let j = shooterTick; j >= Math.max(0, shooterTick - 40); j--) {
      const p = ticks[j].players?.find((pl) => pl.team === team && pl.pid === shooterPid);
      if (p && !(p.x === 0 && p.y === 0)) {
        return { x: p.x, z: p.y, inBox: Math.abs(p.x) > BOX_X, pid: shooterPid, tick: shooterTick };
      }
    }
  }
  // 3) 无 SHOOT 命中：该队站在对方门侧禁区（攻入端）的球员，取离落点最近者
  const atk = isHomeGoal ? 1 : -1;
  for (let j = goalIdx - 1; j >= Math.max(0, goalIdx - LOOKBACK); j--) {
    const p = ticks[j];
    if (!p.players?.length) continue;
    const cand = p.players.filter(
      (pl) => pl.team === team && (atk > 0 ? pl.x > BOX_X : pl.x < -BOX_X) && Math.abs(pl.y - goalZ) <= 14,
    );
    if (!cand.length) continue;
    cand.sort((a, b) => Math.abs(a.y - goalZ) - Math.abs(b.y - goalZ));
    const best = cand[0];
    return { x: best.x, z: best.y, inBox: true, pid: best.pid, tick: j };
  }
  // 4) 兜底：进球前一 tick 的球
  const fbX = prev.ball?.x ?? 0;
  const fbZ = prev.ball?.z ?? 0;
  return { x: fbX, z: fbZ, inBox: Math.abs(fbX) > BOX_X, pid: null, tick: goalIdx - 1 };
}

function detectShots(ticks: ReplayTick[], goals: GoalRow[] | null): Shot[] {
  const shots: Shot[] = [];
  // 用 report goals（同队、±3s 内）匹配进球，取 agent_name 用于展示
  const matchGoal = (goalTeam: string, gt: number | null) => {
    if (!goals || gt == null) return null;
    return goals.find((g) => g.team === goalTeam && g.game_time_secs != null && Math.abs(g.game_time_secs - gt) < 3) ?? null;
  };

  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1];
    const curr = ticks[i];
    if (!prev.score || !curr.score) continue;

    if (
      curr.score.home != null && prev.score.home != null &&
      curr.score.home > prev.score.home
    ) {
      const gz = curr.ball ? Math.max(-4, Math.min(4, curr.ball.z)) : 0;
      const start = findShotStart(ticks, i, prev, 0, true, gz);
      const g = matchGoal("home", prev.gameTime);
      const trail: { x: number; z: number }[] = [];
      for (let j = start.tick; j < i; j++) {
        const b = ticks[j].ball;
        if (b) trail.push({ x: b.x, z: b.z });
      }
      shots.push({
        idx: i, gameTime: prev.gameTime, team: 0,
        pid: start.pid,
        pos: g?.position || (start.pid != null ? (POS_NAMES[start.pid] ?? "?") : "?"),
        agentName: g?.agent_name ?? null,
        startX: start.x, startZ: start.z,
        endX: 55, endZ: gz,
        inBox: start.inBox,
        trail,
      });
    }

    if (
      curr.score.away != null && prev.score.away != null &&
      curr.score.away > prev.score.away
    ) {
      const gz = curr.ball ? Math.max(-4, Math.min(4, curr.ball.z)) : 0;
      const start = findShotStart(ticks, i, prev, 1, false, gz);
      const g = matchGoal("away", prev.gameTime);
      const trail: { x: number; z: number }[] = [];
      for (let j = start.tick; j < i; j++) {
        const b = ticks[j].ball;
        if (b) trail.push({ x: b.x, z: b.z });
      }
      shots.push({
        idx: i, gameTime: prev.gameTime, team: 1,
        pid: start.pid,
        pos: g?.position || (start.pid != null ? (POS_NAMES[start.pid] ?? "?") : "?"),
        agentName: g?.agent_name ?? null,
        startX: start.x, startZ: start.z,
        endX: -55, endZ: gz,
        inBox: start.inBox,
        trail,
      });
    }
  }
  return shots;
}

/* ---- 球场配色（绿茵风） ---- */
const GRASS_DARK   = "#1a4d22";
const GRASS_LIGHT  = "#2d6b35";
const LINE_W       = "rgba(255,255,255,0.78)";
const LABEL_CLR    = "rgba(255,255,255,0.35)";
const NET_CLR      = "rgba(255,255,255,0.25)";
const OUR_CLR      = "#00e676";
const OP_CLR       = "#ff5252";

export default function ShotTrajectory({ replay, goals }: { replay: ReplayData | null; goals?: GoalRow[] | null }) {
  const [hovered, setHovered] = useState(-1);

  const shots = useMemo(() => (replay ? detectShots(replay.ticks, goals ?? null) : []), [replay, goals]);
  const ourTeam = useMemo(() => {
    if (!replay) return null;
    return replay.our_side === "home" ? 0 : replay.our_side === "away" ? 1 : null;
  }, [replay]);

  if (!replay) return null;

  /* 世界坐标 → SVG 坐标 (x:±55 → 0..110, z:±35 → 0..70) */
  const sx = (x: number) => Math.max(0, Math.min(110, x + 55));
  const sy = (z: number) => Math.max(0, Math.min(70, z + 35));

  const color = (s: Shot) => (s.team === ourTeam ? OUR_CLR : OP_CLR);
  const teamName = (t: number) =>
    t === 0 ? (replay.home_name ?? "主场") : (replay.away_name ?? "客场");
  const sideLabel = (t: number) =>
    ourTeam == null ? (t === 0 ? "主场" : "客场") : t === ourTeam ? "我方" : "对方";
  const fmtTime = (s: number | null) =>
    s == null ? "--" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const hoveredShot = hovered >= 0 ? shots[hovered] : null;

  return (
    <div className="chart-box" style={{ position: "relative", overflow: "hidden", borderRadius: 8 }}>
      <h4>射门轨迹</h4>

      {shots.length === 0 ? (
        <div className="sub">暂无射门数据（本场无比分变化）</div>
      ) : (
        <>
          <svg
            viewBox="-4 -4 118 78"
            style={{ width: "100%", display: "block" }}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GRASS_LIGHT} />
                <stop offset="100%" stopColor={GRASS_DARK} />
              </linearGradient>
            </defs>

            {/* ── 草皮 ── */}
            <rect x="0" y="0" width="110" height="70" fill="url(#grass)" rx="3" />
            {/* 割草条纹（横向 7 条，奇数条加深） */}
            {[0, 20, 40, 60].map((y) => (
              <rect key={y} x="0" y={y} width="110" height="10" fill="#000" opacity="0.07" />
            ))}

            {/* ── 白色标线 ── */}
            <g stroke={LINE_W} strokeWidth="0.5" fill="none">
              <rect x="1" y="1" width="108" height="68" rx="1.5" />
              <line x1="55" y1="1" x2="55" y2="69" />
              <circle cx="55" cy="35" r="9" />
              <circle cx="55" cy="35" r="0.5" fill={LINE_W} stroke="none" />
              {/* 禁区 + 球门区 */}
              <rect x="1" y="25" width="17" height="20" />
              <rect x="1" y="30.5" width="7" height="9" />
              <rect x="92" y="25" width="17" height="20" />
              <rect x="102" y="30.5" width="7" height="9" />
              {/* 罚球点 */}
              <circle cx="13" cy="35" r="0.5" fill={LINE_W} stroke="none" />
              <circle cx="97" cy="35" r="0.5" fill={LINE_W} stroke="none" />
              {/* 角旗弧 */}
              <path d="M 1 5 A 4 4 0 0 0 5 1" />
              <path d="M 105 1 A 4 4 0 0 0 109 5" />
              <path d="M 109 65 A 4 4 0 0 0 105 69" />
              <path d="M 5 69 A 4 4 0 0 0 1 65" />
            </g>

            {/* ── 球门（左：x∈[-3,1]，右：x∈[109,113]，y:31..39） ── */}
            <g>
              {/* 左球门 */}
              <line x1="-3" y1="31" x2="1"  y2="31" stroke="#fff" strokeWidth="0.6" opacity="0.9" />
              <line x1="-3" y1="39" x2="1"  y2="39" stroke="#fff" strokeWidth="0.6" opacity="0.9" />
              <line x1="-3" y1="31" x2="-3" y2="39" stroke="#fff" strokeWidth="1"   opacity="0.9" />
              {/* 球网（3 横 + 2 竖） */}
              <line x1="-3" y1="33.5" x2="1"  y2="33.5" stroke={NET_CLR} strokeWidth="0.25" />
              <line x1="-3" y1="36.5" x2="1"  y2="36.5" stroke={NET_CLR} strokeWidth="0.25" />
              <line x1="-1.5" y1="31" x2="-1.5" y2="39" stroke={NET_CLR} strokeWidth="0.25" />
              <line x1="-0.5" y1="31" x2="-0.5" y2="39" stroke={NET_CLR} strokeWidth="0.25" />
              {/* 右球门 */}
              <line x1="109" y1="31" x2="113" y2="31" stroke="#fff" strokeWidth="0.6" opacity="0.9" />
              <line x1="109" y1="39" x2="113" y2="39" stroke="#fff" strokeWidth="0.6" opacity="0.9" />
              <line x1="113" y1="31" x2="113" y2="39" stroke="#fff" strokeWidth="1"   opacity="0.9" />
              <line x1="109" y1="33.5" x2="113" y2="33.5" stroke={NET_CLR} strokeWidth="0.25" />
              <line x1="109" y1="36.5" x2="113" y2="36.5" stroke={NET_CLR} strokeWidth="0.25" />
              <line x1="110.5" y1="31" x2="110.5" y2="39" stroke={NET_CLR} strokeWidth="0.25" />
            </g>

            {/* ── 区域标签 ── */}
            <text x="25" y="38" textAnchor="middle" fontSize="3.5" fill={LABEL_CLR}
                  fontFamily="system-ui, sans-serif" fontWeight="600" letterSpacing="0.8">
              {ourTeam === 0 ? "OUR SIDE" : "HOME"}
            </text>
            <text x="85" y="38" textAnchor="middle" fontSize="3.5" fill={LABEL_CLR}
                  fontFamily="system-ui, sans-serif" fontWeight="600" letterSpacing="0.8">
              {ourTeam === 1 ? "OUR SIDE" : "AWAY"}
            </text>
            <text x="55" y="33" textAnchor="middle" fontSize="2.5" fill={LABEL_CLR}
                  fontFamily="system-ui, sans-serif" letterSpacing="0.5" opacity="0.6">
              CENTER
            </text>

            {/* ── 射门轨迹线 ── */}
            {shots.map((s, i) => {
              const c = color(s);
              const isH = hovered === i;
              const dim = hovered !== -1 && !isH;
              const x1 = sx(s.startX);
              const y1 = sy(s.startZ);
              const x2 = sx(s.endX);
              const y2 = sy(s.endZ);
              const usePoly = s.trail.length >= 2;
              const polyPoints = usePoly
                ? [`${x1},${y1}`, ...s.trail.map((p) => `${sx(p.x)},${sy(p.z)}`), `${x2},${y2}`].join(" ")
                : "";

              return (
                <g key={i} opacity={dim ? 0.15 : 1} style={{ transition: "opacity 0.2s" }}>
                  {/* 轨迹线 */}
                  {usePoly ? (
                    <polyline
                      points={polyPoints}
                      fill="none"
                      stroke={c}
                      strokeWidth={isH ? 0.9 : 0.4}
                      strokeDasharray={s.team !== ourTeam ? "2,1" : "none"}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ) : (
                    <line
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={c}
                      strokeWidth={isH ? 0.9 : 0.4}
                      strokeDasharray={s.team !== ourTeam ? "3,1.5" : "none"}
                      strokeLinecap="round"
                    />
                  )}
                  {/* 中间小球点 */}
                  {usePoly && s.trail.map((p, pi) => (
                    <circle key={pi} cx={sx(p.x)} cy={sy(p.z)} r={0.35}
                      fill={c} opacity={isH ? 0.9 : 0.45}
                    />
                  ))}
                  {/* 起点（射门位置） */}
                  <circle
                    cx={x1} cy={y1}
                    r={isH ? 1.0 : 0.5}
                    fill={c}
                    stroke="#000"
                    strokeWidth="0.2"
                    style={{ cursor: "pointer", transition: "r 0.2s" }}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(-1)}
                  />
                  {/* 禁区射门标识环 */}
                  {s.inBox && (
                    <circle
                      cx={x1} cy={y1}
                      r={isH ? 1.6 : 1.1}
                      fill="none"
                      stroke={c}
                      strokeWidth="0.25"
                      opacity="0.45"
                    />
                  )}
                  {/* 终点（球门入球点） */}
                  <circle
                    cx={x2} cy={y2}
                    r={isH ? 0.8 : 0.45}
                    fill="none"
                    stroke={c}
                    strokeWidth={isH ? 0.45 : 0.25}
                    opacity={isH ? 1 : 0.6}
                    style={{ transition: "r 0.2s, opacity 0.2s" }}
                  />
                  {/* hover 时方向箭头 */}
                  {isH && (() => {
                    const dx = x2 - x1, dy = y2 - y1;
                    const len = Math.hypot(dx, dy);
                    if (len < 2) return null;
                    const ux = dx / len, uy = dy / len;
                    const bx = x2 - ux * 4, by = y2 - uy * 4;
                    return (
                      <polygon
                        points={`${x2 - ux * 2},${y2 - uy * 2} ${bx - uy * 1.2},${by + ux * 1.2} ${bx + uy * 1.2},${by - ux * 1.2}`}
                        fill={c}
                        opacity="0.9"
                      />
                    );
                  })()}
                </g>
              );
            })}
          </svg>

          {/* Tooltip */}
          {hoveredShot && (
            <div
              style={{
                position: "absolute",
                top: 8,
                right: 12,
                background: "rgba(0,0,0,0.88)",
                backdropFilter: "blur(8px)",
                border: `1.5px solid ${color(hoveredShot)}`,
                borderRadius: 6,
                padding: "8px 14px",
                fontSize: 12,
                pointerEvents: "none",
                color: "#fff",
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.7,
                minWidth: 130,
              }}
            >
              <div style={{ color: color(hoveredShot), fontWeight: 700 }}>
                {sideLabel(hoveredShot.team)} · {teamName(hoveredShot.team)}
              </div>
              <div style={{ opacity: 0.85 }}>
                {fmtTime(hoveredShot.gameTime)} · {hoveredShot.agentName ?? `${hoveredShot.pos} #${hoveredShot.pid ?? "?"}`}
              </div>
              <div style={{ opacity: 0.55, fontSize: 11 }}>
                入球 {hoveredShot.endZ > 1 ? "右侧" : hoveredShot.endZ < -1 ? "左侧" : "中路"}
                {" · "}{hoveredShot.inBox ? "禁区" : "远射"}
              </div>
            </div>
          )}

          {/* 图例 */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            marginTop: 10,
            fontSize: 11,
            color: "rgba(255,255,255,0.45)",
            fontFamily: "system-ui, sans-serif",
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="22" height="6" style={{ display: "block" }}>
                <line x1="0" y1="3" x2="22" y2="3" stroke={OUR_CLR} strokeWidth="2" strokeLinecap="round" />
              </svg>
              我方射门
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="22" height="6" style={{ display: "block" }}>
                <line x1="0" y1="3" x2="22" y2="3" stroke={OP_CLR} strokeWidth="2" strokeDasharray="4,2" strokeLinecap="round" />
              </svg>
              对方射门
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="12" height="12" style={{ display: "block" }}>
                <circle cx="6" cy="6" r="4" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="0.6" />
                <circle cx="6" cy="6" r="2" fill="rgba(255,255,255,0.5)" />
              </svg>
              禁区射门
            </span>
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>
              共 {shots.length} 次
            </span>
          </div>
        </>
      )}
    </div>
  );
}
