# Agentic Football · Match Intel Console

一个面向 **AWS Agentic Football Cup**（5v5 虚拟足球锦标赛）的**全栈赛事情报台**。
后端用 FastAPI 抓取并落库官方比赛数据，前端用 React 提供「比赛分析 / 数据统计 / 赛事重播 / 赛事排行 / 赛事配置」五合一控制台，并内置基于 Unity WebGL 的官方回放客户端。

> 一句话定位：**把官方 REST API 的比赛/逐 tick 指令数据，变成可查询、可可视化、可回放的分析界面。**

---

## 1. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Python 3.9+ · FastAPI · Uvicorn · httpx | REST API + 上游取数 + SQLite 落库 |
| 数据库 | SQLite | 零运维本地库，首次运行自动建表 |
| 前端 | React 19 · TypeScript · Vite 8 · react-konva · recharts · oxlint | 控制台 UI + 图表 + 球场渲染 |
| 回放 | Unity WebGL（`asw-agentic-soccer-web`）+ CORS 代理 | 官方 `ReplayClient` 场景 |
| 脚本 | Bash / PowerShell | 一键启动、端口清理 |

---

## 2. 目录结构

```
agentic-football/
├── server/                  # 后端（FastAPI）
│   ├── main.py              # 应用入口：CORS / 路由挂载 / /health
│   ├── db.py                # SQLite 数据层（建表 + 读写函数）
│   ├── fetcher.py           # 上游取数层（httpx + 3 次重试，Bearer team:<CODE>）
│   ├── fetch_service.py     # 拉取编排：比赛增量 + 积分榜快照 + fetch_runs 日志
│   ├── requirements.txt     # fastapi / uvicorn / httpx
│   └── routers/
│       ├── tournaments.py   # 赛事配置（按 team_code 不可变）
│       ├── fetch.py         # 手动拉取 + 拉取日志
│       ├── analytics.py     # 比赛 / 重播 / 统计 / 排行榜
│       └── unity.py          # Unity 回放 API（matches / replays / rproxy）
│
├── frontend/                # 前端（React + Vite）
│   ├── index.html           # 入口 HTML
│   ├── vite.config.ts       # 代理 /api、/health、/unity/{matches,replays,rproxy} → 后端 8000；其余 /unity/* 由 public/unity 托管
│   ├── package.json         # React 19 / konva / recharts / oxlint
│   ├── public/unity/        # Unity WebGL 构建产物（Vite 原生托管）
│   └── src/
│       ├── api.ts          # 后端 API 客户端
│       ├── App.tsx         # 顶层布局 + 5 个 Tab
│       ├── types.ts        # 类型定义
│       ├── components/      # Analysis / Stats / Replay / Leaderboard / Setup
│       └── unity/          # interceptors.ts（rproxy 注入）+ unity-loader.ts
│
├── start.sh  start.bat      # 一键启动（Linux/macOS · Windows）
├── get-pid.ps1              # 按端口查占用进程的辅助脚本（Windows）
└── AGENTS.md                # Trellis 项目指引
```

---

## 3. 架构与数据流

```
  ┌─────────────────────────┐    REST (Bearer team:<CODE>)    ┌──────────────────────────┐
  │  Upstream API           │◀───────────────────────────────│  server/ (FastAPI)        │
  │  AWS Agentic Football   │  GET /matches /prompts          │  fetcher.py → fetch_      │
  │  Cup (us-east-1)        │  /standings /teams/mine         │  service.py → db.py       │
  └─────────────────────────┘                                └───────────┬──────────────┘
                                                                       │ REST /api/*
                                                                       ▼
  ┌─────────────────────────┐                          ┌──────────────────────────┐
  │  relay                   │  通过 /unity/rproxy       │  frontend/ (React+Vite)   │
  │  game.agentic-football   │  服务端代拉（绕 CORS）      │  Tabs:                   │
  │  .aws.dev                │◀─────────────────────────│   比赛分析 数据统计        │
  │  (回放 msgpack 源站)     │  /unity/replays/{id}      │   赛事重播 赛事排行 配置   │
  └─────────────────────────┘                          └──────────────────────────┘
        ▲ Unity WebGL ReplayClient（wasm）从上面拉回放二进制
```

- **取数**：后端 `fetcher.py` 用 `Bearer team:<CODE>` 鉴权拉取官方数据，落库 SQLite。
- **展示**：前端经 Vite 代理把 `/api`、`/unity` 转发到后端 8000。
- **回放**：前端 `Replay` 标签页加载 Unity WebGL 客户端，经后端 `/unity/replays/{vendor_match_id}` 与 `/unity/rproxy` 拿回放二进制与跨域资源。

---

## 4. 环境要求

- **Python** ≥ 3.9（FastAPI / Uvicorn / httpx）
- **Node.js** ≥ 20.19（Vite 8 要求）
- 可访问的上游 API（需有效的 `team_code`）
- 操作系统：Windows / Linux / macOS 均可

---

## 5. 快速开始

### 方式 A：一键启动（推荐）

**Linux / macOS：**
```bash
bash start.sh
```

**Windows（双击或 CMD 运行）：**
```bat
start.bat
```

脚本会自动：检查 Python/Node 依赖 → 安装缺失包 → 释放被占端口 → 启动后端（8000）→ 启动前端（5173）→ 等待 `/health` 就绪。

启动后访问：
- 前端控制台：<http://127.0.0.1:5173/>
- 后端健康检查：<http://127.0.0.1:8000/health>

### 方式 B：手动启动

```bash
# 后端
cd server
python -m pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000

# 另开终端，前端
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

### 停止
- 一键脚本：关闭弹出的后端/前端窗口，或 `kill <PID>`（脚本会打印 PID）。
- 手动：在各自终端 `Ctrl+C`。

---

## 6. 后端 API 速查

所有接口前缀已在 `main.py` 中挂载。鉴权为**后端→上游**使用，前端无需带 token。

### 赛事配置（`/api/tournaments`）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tournaments` | 创建赛事（body: `team_code`, `tournament_id`, `base_url?`）。按 `team_code` 不可变，重复创建返回 409 |
| GET | `/api/tournaments` | 列出全部已建赛事 |
| GET | `/api/tournaments/{local_id}` | 单个赛事详情 |

### 数据拉取（`/api/tournaments`）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tournaments/{local_id}/fetch?force=false` | 增量拉取比赛 + 积分榜快照；`force=true` 重拉已结束比赛 |
| GET | `/api/tournaments/{local_id}/fetch-runs?limit=20` | 拉取运行日志（成功/失败/跳过计数、错误摘要） |

### 分析与统计（`/api`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tournaments/{local_id}/matches` | 该赛事全部比赛列表 |
| GET | `/api/tournaments/{local_id}/leaderboard` | 最近一次积分榜快照 |
| GET | `/api/matches/{match_id}` | 单场详情（含进球、指令分布、agent 延迟） |
| GET | `/api/matches/{match_id}/replay` | 逐 tick 指令重播数据（`tick_prompts`） |
| GET | `/api/stats?tournament_id=` | 汇总统计（可指定赛事或全量） |

### Unity 回放（`/unity`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/unity/matches` | 本地可回放比赛列表（含 `vendor_match_id`） |
| GET | `/unity/replays/{vendor_match_id}` | 回放二进制（本地缓存优先，miss 时从 relay 下载并缓存） |
| GET | `/unity/rproxy?u=` | 服务端代拉远程 URL（绕浏览器 CORS） |

---

## 7. 前端功能（5 个 Tab）

| Tab | 组件 | 功能 |
|---|---|---|
| 比赛分析 | `Analysis.tsx` | 单场详情、进球时间轴、双方指令分布对比、MVP/最快 agent |
| 数据统计 | `Stats.tsx` | 多场汇总（控球、射门、指令频率等，recharts 图表） |
| 赛事重播 | `Replay.tsx` + `unity/` | 加载 Unity WebGL 回放客户端，按 `vendor_match_id` 选场回放 |
| 赛事排行 | `Leaderboard.tsx` | 展示最近一次积分榜快照 |
| 赛事配置 | `Setup.tsx` | 创建赛事（填 `team_code` / `tournament_id`），触发拉取 |

顶部赛事下拉框在多个赛事间切换；右上角带 UTC 实时时钟。

---

## 8. 数据模型（SQLite）

数据模型由 `server/db.py` 定义，首次运行后端时自动建库与建表。

| 表 | 关键字段 | 用途 |
|---|---|---|
| `tournaments` | `team_code`, `tournament_id`, `team_id`, `base_url` | 赛事配置（不可变） |
| `matches` | `match_id`, `home/away_*`, `home_score`, `status`, `detail_json` | 比赛主表 |
| `goals` | `match_id`, `team`, `position`, `agent_name`, `game_time_secs` | 进球时间轴 |
| `command_breakdown` | `match_id`, `team`, `command`, `count` | 各指令使用计数 |
| `agent_stats` | `match_id`, `team`, `position`, `latency_avg_ms`, `success_rate` | agent 延迟/成功率 |
| `tick_prompts` | `match_id`, `side`, `command_id`, `command_type`, `prompt_json`, `result_json` | 逐 tick 指令（重播数据源） |
| `leaderboard_rows` | `rank`, `team_name`, `wins`, `goals_*`, `points` … | 积分榜快照 |
| `fetch_runs` | `matches_seen/new/refreshed/skipped/failed`, `error_text` | 拉取运行日志 |

---

## 9. 上游 API 与鉴权（要点）

核心鉴权格式：

```
Authorization: Bearer team:<TEAM_CODE>
                  ^^^^^^ 缺这个前缀 → 全部 403
```

- **主 API（拿自己队数据）**：`https://l3fmtx4zp0.execute-api.us-east-1.amazonaws.com/prod`
- **公开 API（看别队/联赛）**：`https://api.agenticfootballcup.ai`（无需鉴权）
- **回放 relay**：`https://game.agentic-football.aws.dev`

---

## 10. Unity 回放

回放客户端由前端 `Replay` 标签页直接经 Vite 从 `frontend/public/unity/` 托管（绝对路径 `/unity/*`），仅把数据类 API（`/unity/matches`、`/unity/replays`、`/unity/rproxy`）代理到后端 8000。后端只提供回放数据接口，不托管任何静态资源，回放二进制由后端在本地缓存。

> 提示：客户端视频播放需在**真 Chrome/Edge** 中打开（内置预览面板可能缺 H.264 解码器）。真·10 人坐标由 Unity 私有的 MagicOnion/msgpack 协议封装，REST 的 `/prompts` 只返回**球坐标 + playerCount**。

---

## 11. 常见问题 / 排错

**Q1：前端打不开 / 提示后端未启动**
确认后端已在 8000 跑通：`curl http://127.0.0.1:8000/health` 应返回 `{"status":"ok"}`。检查 Vite 代理配置（`frontend/vite.config.ts`）。

**Q2：创建赛事报 403 / 422**
`team_code` 无效或鉴权前缀缺失。核对第 9 节的 `Bearer team:<CODE>` 格式与 `base_url` 默认值。

**Q3：回放页白屏**
本地 `frontend/public/unity/asw-agentic-soccer-web.wasm` 须为完整 61.83 MB。若被截断，Unity 客户端无法编译启动，需补充完整 wasm。

**Q4：拉取比赛报 incomplete / 部分失败**
官方 `/matches` 仅返回**最近 20 场**，且赛后 prompt 保留期极短；单场失败不影响整体，详见 `fetch-runs` 日志（`/api/tournaments/{id}/fetch-runs`）。

**Q5：端口被占用**
`start.bat` 会自动 kill 占用 8000/5173 的进程；手动可改 `start.sh`/`start.bat` 顶部的 `BACKEND_PORT`/`FRONTEND_PORT`。

---

## 12. 备注

- 本项目由 **Trellis** 管理（见 `AGENTS.md`）。
- 上游数据产权归 AWS Agentic Football Cup；本仓库仅做本地分析用途。
