import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { installUnityInterceptors, RELAY_BASE } from "../unity/interceptors";
import { installConsoleLifecycleHook } from "../unity/lifecycle";
import { installPlaybackWatch } from "../unity/playback-watch";
import { bootUnity, destroyUnity, type UnityInstance } from "../unity/unity-loader";
import ReplayHud, { type ReplayPrompts } from "./ReplayHud";
import type { Tournament } from "../types";

interface UnityMatch {
  vendor_match_id: string;
  home: string | null;
  away: string | null;
  home_score: number | null;
  away_score: number | null;
  status: string | null;
  starting_at: string | null;
  our_side: string | null;
  is_practice: boolean;
  tournament_id?: string | null;
}

function fmtMatchTime(iso: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch {
    return iso;
  }
}

export default function Replay({ tournament }: { tournament: Tournament | null }) {
  const [unityMatches, setUnityMatches] = useState<UnityMatch[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [listErr, setListErr] = useState("");
  const [replayData, setReplayData] = useState<ReplayPrompts | null>(null);
  const [replayErr, setReplayErr] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<UnityInstance | null>(null);
  const watchCleanupRef = useRef<(() => void) | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);

  useEffect(() => {
    installUnityInterceptors();
    // 关键：必须在 createUnityInstance 之前装好，才能抓到客户端开播时的
    // [Lifecycle] 日志（面板据此做闭环对齐）。
    installConsoleLifecycleHook();
    // 按顶部所选赛事筛选（与赛事配置/排行/分析/统计页一致）；tournament_id
    // 为空时回退为全部（保持向后兼容）。
    const qs = tournament?.tournament_id
      ? `?tournament_id=${encodeURIComponent(tournament.tournament_id)}`
      : "";
    fetch(`/unity/matches${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.items) setUnityMatches(d.items as UnityMatch[]);
      })
      .catch((e: unknown) => setListErr(`比赛列表加载失败: ${e}`));

    return () => {
      watchCleanupRef.current?.();
      watchCleanupRef.current = null;
      if (instanceRef.current) {
        destroyUnity(instanceRef.current);
        instanceRef.current = null;
      }
    };
  }, [tournament?.tournament_id]);

  const fetchReplayData = useCallback(async (matchId: string, silent = false) => {
    if (!silent) {
      setReplayData(null);
      setReplayErr("");
    }
    try {
      const r = await fetch(`/unity/replay-prompts/${encodeURIComponent(matchId)}`);
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          msg = j.detail || JSON.stringify(j);
        } catch {
          /* ignore */
        }
        setReplayErr(msg);
        return;
      }
      setReplayData((await r.json()) as ReplayPrompts);
    } catch (e) {
      setReplayErr((e as Error).message);
    }
  }, []);

  const startReplay = useCallback(async (matchId: string) => {
    if (!matchId) return;
    setProgress(0);
    setErr("");
    fetchReplayData(matchId);
    if (instanceRef.current) {
      destroyUnity(instanceRef.current);
      instanceRef.current = null;
    }
    setCanvasKey((k) => k + 1);
    await new Promise((r) => setTimeout(r, 50));
    if (!canvasRef.current) return;
    try {
      const inst = await bootUnity({
        canvas: canvasRef.current,
        matchId,
        server: RELAY_BASE,
        onProgress: (p) => setProgress(p),
      });
      instanceRef.current = inst;
      setProgress(100);
      // 装"播放观测"：捕获画面里的 START 点击（= 真正的开播时刻）+ 画面内容变化。
      // 必须装在 createUnityInstance 之后（canvas 此时才被 Unity 接管）。
      watchCleanupRef.current?.();
      watchCleanupRef.current = canvasRef.current ? installPlaybackWatch(canvasRef.current) : null;
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [fetchReplayData]);

  // 回放二进制到货后静默重取一次：后端此时已能生成播放时间轴（首播场景的补取）
  const refetchPrompts = useCallback(() => {
    if (selectedId) fetchReplayData(selectedId, true);
  }, [selectedId, fetchReplayData]);

  const sel = unityMatches.find((m) => m.vendor_match_id === selectedId) ?? null;

  // 按比赛时间倒序（无 starting_at 的排到最后），保证「新比赛在前」。
  // 后端已按 COALESCE(starting_at, fetched_at) DESC 返回，这里再排一次以防万一。
  const visibleMatches = useMemo(() => {
    return [...unityMatches].sort((a, b) => {
      const ta = a.starting_at ? new Date(a.starting_at).getTime() : -Infinity;
      const tb = b.starting_at ? new Date(b.starting_at).getTime() : -Infinity;
      return tb - ta;
    });
  }, [unityMatches]);

  return (
    <div className="card fill">
      <div className="row gap">
        <label className="sel-wrap">
          比赛：
          <select
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              startReplay(e.target.value);
            }}
            disabled={!unityMatches.length}
          >
            <option value="">
              {visibleMatches.length
                ? `— 本地 ${visibleMatches.length} 场可回放 —`
                : listErr || "加载中…"}
            </option>
            {visibleMatches.map((m) => (
              <option key={m.vendor_match_id} value={m.vendor_match_id}>
                {m.is_practice ? "[练习] " : ""}
                {m.home} {m.home_score}-{m.away_score} {m.away}
                {" · "}{fmtMatchTime(m.starting_at)}
              </option>
            ))}
          </select>
        </label>
        {listErr && <span className="msg err">{listErr}</span>}
        {err && <span className="msg err">{err}</span>}
        {replayErr && <span className="msg err">{replayErr}</span>}
      </div>

      {progress !== null && progress < 100 && (
        <div className="sub">
          加载 Unity… {progress.toFixed(1)}%
          {progress > 0 && (
            <div
              style={{
                width: 200,
                height: 6,
                background: "#1e293b",
                borderRadius: 3,
                marginTop: 4,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: "100%",
                  background: "#3b82f6",
                  borderRadius: 3,
                  transition: "width 0.2s",
                }}
              />
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0, width: "100%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "#000",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <canvas
            key={canvasKey}
            ref={canvasRef}
            id="unity-canvas"
            tabIndex={-1}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        </div>
        <ReplayHud
          data={replayData}
          homeName={sel?.home ?? null}
          awayName={sel?.away ?? null}
          matchId={selectedId}
          onNeedTimeline={refetchPrompts}
        />
      </div>
    </div>
  );
}
