import { useCallback, useEffect, useRef, useState } from "react";
import { installUnityInterceptors, RELAY_BASE } from "../unity/interceptors";
import { bootUnity, destroyUnity, type UnityInstance } from "../unity/unity-loader";

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

export default function Replay() {
  const [unityMatches, setUnityMatches] = useState<UnityMatch[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [listErr, setListErr] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<UnityInstance | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);

  useEffect(() => {
    installUnityInterceptors();
    fetch("/unity/matches")
      .then((r) => r.json())
      .then((d) => {
        if (d?.items) setUnityMatches(d.items as UnityMatch[]);
      })
      .catch((e: unknown) => setListErr(`比赛列表加载失败: ${e}`));

    return () => {
      if (instanceRef.current) {
        destroyUnity(instanceRef.current);
        instanceRef.current = null;
      }
    };
  }, []);

  const startReplay = useCallback(async (matchId: string) => {
    if (!matchId) return;
    setProgress(0);
    setLoaded(false);
    setErr("");
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
      setLoaded(true);
      setProgress(100);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  return (
    <div className="card">
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
              {unityMatches.length
                ? `— 本地 ${unityMatches.length} 场可回放 —`
                : listErr || "加载中…"}
            </option>
            {unityMatches.map((m) => (
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
      {loaded && (
        <div className="sub" style={{ color: "#9fe3b0" }}>
          Unity 已加载 — 等待回放开始
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
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
    </div>
  );
}
