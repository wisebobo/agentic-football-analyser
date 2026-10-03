export interface Tournament {
  id: number;
  team_code: string;
  tournament_id: string;
  team_id: string;
  team_name: string;
  tournament_name: string | null;
  base_url: string;
  created_at: string;
  auto_enabled: number;
  practice_opponents: string;
}

export interface PracticeMatchResult {
  opponent: string;
  ok: boolean;
  err: string | null;
  response: unknown;
}

/** 调度器节拍状态（全局共享，非 per-tournament） */
export interface SchedulerStatus {
  interval_seconds: number;
  /** 下次运行时间，本地 'HH:MM:SS' */
  next_run_at: string | null;
  /** 下次运行 epoch 秒（后端时钟），前端倒计时基准 */
  next_run_epoch: number;
  last_cycle_end: string | null;
  /** 本轮是否正在执行 */
  running: boolean;
  /** 全局开关是否启用（来自 scheduler_config） */
  enabled: boolean;
}

/** 全局调度配置（存库，热生效） */
export interface SchedulerConfig {
  enabled: boolean;
  interval_seconds: number;
}

/** 手动「立即运行」结果；上一轮未结束则跳过（ran=false，无 next） */
export interface SchedulerRunResult {
  ran: boolean;
  next?: SchedulerStatus;
}

export interface MatchRow {
  match_id: string;
  our_side: string | null;
  home_team_name: string | null;
  away_team_name: string | null;
  home_score: number | null;
  away_score: number | null;
  status: string | null;
  match_duration_seconds: number | null;
  mvp_agent_name: string | null;
  report_available: number | null;
  is_practice: number | null;
  starting_at: string | null;
  tournament_id?: string;
  fetched_at: string;
}

export interface GoalRow {
  team: string;
  position: string | null;
  agent_name: string | null;
  game_time_secs: number | null;
}

export interface AgentStat {
  team: string;
  position: string;
  latency_avg_ms: number | null;
  success_rate: number | null;
}

export interface MatchFull {
  match_id: string;
  our_side: string | null;
  home_team_name: string | null;
  away_team_name: string | null;
  home_score: number | null;
  away_score: number | null;
  status: string | null;
  match_duration_seconds: number | null;
  mvp_agent_name: string | null;
  is_practice: number | null;
  starting_at: string | null;
  goals: GoalRow[];
  command_breakdown: { home: Record<string, number>; away: Record<string, number> };
  agent_stats: AgentStat[];
  tick_count: number;
  ticks: { command_type: string | null; response_time: number | null; success: number | null }[];
}

export interface LeaderboardRow {
  rank: number | null;
  team_id: string | null;
  team_name: string | null;
  coach_name: string | null;
  matches_played: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
  goals_scored: number | null;
  goals_conceded: number | null;
  goal_difference: number | null;
  points: number | null;
  icon_url: string | null;
}

export interface LeaderboardResp {
  tournament_id: string;
  our_team_id: string;
  snapshot: { fetched_at: string; rows: LeaderboardRow[] } | null;
}

export interface FetchRun {
  id: number;
  tournament_id: string;
  started_at: string | null;
  finished_at: string | null;
  matches_seen: number | null;
  new_matches: number | null;
  refreshed: number | null;
  skipped: number | null;
  failed: number | null;
  leaderboard_rows: number | null;
  incomplete: number | null;
  error_text: string | null;
}

export interface ReplayCmd {
  pid: number | null;
  team: number | null;
  cmd: string | null;
  tx: number | null;
  ty: number | null;
  sprint: number;
  /** 命令完整参数（引擎 result[].parameters 原样透出）；老数据可能为 null */
  params?: Record<string, unknown> | null;
  /** 0=一次性 / >0=持续 N 秒 / -1=持续到被覆盖 */
  duration?: number | null;
}

export interface ReplayTick {
  i: number;
  t: number | null;
  gameTime: number | null;
  playMode: string | null;
  score: { home: number | null; away: number | null } | null;
  ball: { x: number; z: number } | null;
  poss: unknown;
  poss_team: number | null;
  cmds: ReplayCmd[];
  players: { pid: number; team: number; x: number; y: number; tx: number; ty: number }[];
  sides_present: number[];
  our_team: number | null;
}

export interface ReplayData {
  tick_count: number;
  available: boolean;
  player_positions_available: boolean;
  warnings: string[];
  our_side: string | null;
  home_name: string | null;
  away_name: string | null;
  ticks: ReplayTick[];
}

export interface Stats {
  total: number;
  known_side: number;
  wins: number;
  losses: number;
  draws: number;
  command_breakdown: { home: Record<string, number>; away: Record<string, number> };
  agent_agg: Record<string, Record<string, { latency: number; success: number }>>;
  possession: { home: number; away: number };
  shots: { home: { shots: number; sot: number }; away: { shots: number; sot: number } };
  series: {
    match_id: string; home: string | null; away: string | null;
    home_score: number; away_score: number;
    we: number | null; op: number | null; our_side: string | null;
  }[];
  matches: {
    match_id: string; home: string | null; away: string | null;
    home_score: number | null; away_score: number | null;
    our_side: string | null; status: string | null;
    is_practice: number | null; starting_at: string | null;
    duration: number | null;
  }[];
}


