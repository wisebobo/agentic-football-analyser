import type {
  Tournament, MatchRow, MatchFull, LeaderboardResp, FetchRun, Stats, ReplayData,
  PracticeMatchResult, SchedulerStatus,
} from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      msg = j.detail || j.error || JSON.stringify(j);
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  listTournaments: () => req<Tournament[]>("/api/tournaments"),
  createTournament: (body: { team_code: string; tournament_id: string; base_url?: string }) =>
    req<Tournament>("/api/tournaments", { method: "POST", body: JSON.stringify(body) }),
  toggleAuto: (tid: number, enabled: boolean) =>
    req<Tournament>(`/api/tournaments/${tid}/auto`, { method: "POST", body: JSON.stringify({ enabled }) }),
  setOpponents: (tid: number, opponents: string[]) =>
    req<Tournament>(`/api/tournaments/${tid}/opponents`, { method: "POST", body: JSON.stringify({ opponents }) }),
  triggerPracticeMatch: (tid: number) =>
    req<PracticeMatchResult>(`/api/tournaments/${tid}/practice-match`, { method: "POST" }),

  fetchNow: (tid: number, force = false) =>
    req<FetchRun>(`/api/tournaments/${tid}/fetch${force ? "?force=true" : ""}`, { method: "POST" }),
  fetchRuns: (tid: number, limit = 20) =>
    req<FetchRun[]>(`/api/tournaments/${tid}/fetch-runs?limit=${limit}`),

  matches: (tid: number) => req<MatchRow[]>(`/api/tournaments/${tid}/matches`),
  matchFull: (mid: string) => req<MatchFull>(`/api/matches/${mid}`),
  replay: (mid: string) => req<ReplayData>(`/api/matches/${mid}/replay`),

  stats: (tid: number) => req<Stats>(`/api/stats?tournament_id=${tid}`),
  leaderboard: (tid: number) => req<LeaderboardResp>(`/api/tournaments/${tid}/leaderboard`),

  /** 调度器节拍状态（全局）；失败抛错，由调用方决定降级 */
  schedulerStatus: () => req<SchedulerStatus>("/api/scheduler/status"),
};

export const DEFAULT_BASE_URL = "https://l3fmtx4zp0.execute-api.us-east-1.amazonaws.com/prod";
