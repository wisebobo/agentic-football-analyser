#!/usr/bin/env bash
# Agentic Football - startup script (Linux/macOS)
# Usage: bash start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"
SERVER_DIR="$ROOT/server"
FRONTEND_DIR="$ROOT/frontend"
BACKEND_PORT=8000
FRONTEND_PORT=5173

echo "============================================================"
echo "  Agentic Football - Starting..."
echo "============================================================"
echo

# ---- 1. Check Python deps ----
echo "[1/4] Checking Python dependencies (fastapi / uvicorn / httpx)..."
if ! python3 -c "import fastapi, uvicorn, httpx" 2>/dev/null; then
    echo "   Missing deps, installing ..."
    python3 -m pip install -r "$SERVER_DIR/requirements.txt" --quiet
    if ! python3 -c "import fastapi, uvicorn, httpx"; then
        echo "   [!] Python deps install failed."
        exit 1
    fi
fi
echo "   [OK] Python deps ready"
echo

# ---- 2. Check Node deps ----
echo "[2/4] Checking Node.js dependencies ..."
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "   First run - installing npm deps ..."
    (cd "$FRONTEND_DIR" && npm install)
else
    echo "   node_modules exists, skipping."
fi
echo "   [OK] Node.js deps ready"
echo

# ---- 3. Free ports ----
echo "[3/4] Checking ports $BACKEND_PORT / $FRONTEND_PORT ..."
for PORT in "$BACKEND_PORT" "$FRONTEND_PORT"; do
    PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
    if [ -n "$PID" ]; then
        echo "   [!] Port $PORT in use (PID $PID), killing ..."
        kill -9 "$PID" 2>/dev/null || true
        sleep 1
    fi
done
echo "   [OK] Ports ready"
echo

# ---- 4. Start backend ----
echo "[4/4] Starting backend (127.0.0.1:$BACKEND_PORT) ..."
nohup uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT" \
    > /tmp/agentic-football-backend.log 2>&1 &
BACKEND_PID=$!
echo "   -> Backend started (PID $BACKEND_PID)"

echo "   Waiting for backend to be ready ..."
WAITED=0
until curl -sf "http://127.0.0.1:$BACKEND_PORT/health" > /dev/null 2>&1; do
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 15 ]; then
        echo "   [!] Backend did not respond to /health within 15s. Check /tmp/agentic-football-backend.log"
        exit 1
    fi
    sleep 1
done
echo "   [OK] Backend ready (http://127.0.0.1:$BACKEND_PORT/health)"
echo

# ---- 5. Start frontend ----
echo "Starting frontend (127.0.0.1:$FRONTEND_PORT) ..."
nohup npm run dev -- --host 127.0.0.1 \
    > /tmp/agentic-football-frontend.log 2>&1 &
FRONTEND_PID=$!
echo "   -> Frontend started (PID $FRONTEND_PID)"
echo

echo "============================================================"
echo "  [OK] All services started!"
echo
echo "  Frontend: http://127.0.0.1:$FRONTEND_PORT/"
echo "  Backend:  http://127.0.0.1:$BACKEND_PORT/health"
echo "  Stop:     kill $BACKEND_PID / $FRONTEND_PID"
echo "  Logs:     /tmp/agentic-football-*.log"
echo "============================================================"
