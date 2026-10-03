@echo off
REM Agentic Football - One-click startup script
REM Check deps -> free ports -> start backend -> start frontend
REM Usage: double-click or run from CMD
setlocal enabledelayedexpansion

pushd "%~dp0"
set "ROOT=%cd%"
set "SERVER_DIR=%ROOT%\server"
set "FRONTEND_DIR=%ROOT%\frontend"
set "BACKEND_PORT=8000"
set "FRONTEND_PORT=5173"

echo ============================================================
echo   Agentic Football - Starting...
echo ============================================================
echo.

REM --- 1. Find Python ---
echo [1/4] Checking Python environment ...
set "PYTHON_CMD="
for %%p in (
    "D:\Tools\miniconda3\python.exe"
    "C:\Users\%USERNAME%\miniconda3\python.exe"
    "C:\Users\%USERNAME%\anaconda3\python.exe"
    python
) do (
    if not defined PYTHON_CMD (
        %%p -c "import fastapi, uvicorn, httpx" >nul 2>&1
        if not errorlevel 1 set "PYTHON_CMD=%%p"
    )
)
if not defined PYTHON_CMD (
    echo   [WARN] Python not found or deps missing.
    echo       Install Python 3.9+ and add to PATH, then retry.
    pause
    exit /b 1
)
echo   [OK] Python: !PYTHON_CMD!
echo.

REM --- 2. Check/install Python deps ---
echo [2/4] Checking Python dependencies ...
for %%m in (fastapi uvicorn httpx) do (
    call :check_dep !PYTHON_CMD! %%m
    if errorlevel 1 (
        echo   [WARN] Failed to install %%m.
        pause
        exit /b 1
    )
)
echo   [OK] Python deps ready
echo.

REM --- 3. Check Node deps ---
echo [3/4] Checking Node.js dependencies ...
if not exist "%FRONTEND_DIR%\node_modules" (
    echo   First run - installing npm deps ...
    pushd "%FRONTEND_DIR%"
    call npm install
    popd
    if errorlevel 1 (
        echo   [WARN] npm install failed. Check network and retry.
        pause
        exit /b 1
    )
) else (
    echo   node_modules exists, skipping.
)
echo   [OK] Node.js deps ready
echo.

REM --- 4. Free ports ---
echo [4/4] Checking ports %BACKEND_PORT% / %FRONTEND_PORT% ...
call :free_port %BACKEND_PORT% "backend-uvicorn"
call :free_port %FRONTEND_PORT% "frontend-vite"
echo   [OK] Ports ready
echo.

REM --- 5. Start backend ---
echo Starting backend (127.0.0.1:%BACKEND_PORT%) ...
start "AgenticFootball Backend" cmd /c "cd /d %SERVER_DIR% && uvicorn main:app --reload --host 127.0.0.1 --port %BACKEND_PORT%"
echo   -> Backend window opened
echo.

echo Waiting for backend to be ready ...
set /a WAITED=0
:wait_loop
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
set /a WAITED+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%BACKEND_PORT%/health' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    if !WAITED! GEQ 15 (
        echo.
        echo   [WARN] Backend did not respond to /health within 15s. Check backend window.
        pause
        exit /b 1
    )
    goto :wait_loop
)
echo   [OK] Backend ready (http://127.0.0.1:%BACKEND_PORT%/health)
echo.

REM --- 6. Start frontend ---
echo Starting frontend (127.0.0.1:%FRONTEND_PORT%) ...
start "AgenticFootball Frontend" cmd /c "cd /d %FRONTEND_DIR% && npm run dev -- --host 127.0.0.1"
echo   -> Frontend window opened
echo.

echo ============================================================
echo   [OK] All services started!
echo.
echo   Frontend: http://127.0.0.1:%FRONTEND_PORT%/
echo   Backend:  http://127.0.0.1:%BACKEND_PORT%/health
echo   Close:    close the windows or press Ctrl+C
echo ============================================================
echo.
pause
exit /b 0

REM --- check_dep: check a single Python package, install if missing ---
REM Args: python_path  package_name
:check_dep
set "PY=%~1"
set "PKG=%~2"
"%PY%" -c "import %PKG%" >nul 2>&1
if not errorlevel 1 exit /b 0
echo   Installing %PKG% ...
"%PY%" -m pip install "%PKG%>=0.110" --quiet >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

REM --- free_port: find and kill process holding a port ---
REM Args: port_number  service_name
:free_port
set "PORT=%~1"
set "SVC=%~2"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%PORT% "') do (
    if not "%%p"=="0" if not defined _KILLED_%%p (
        set "_KILLED_%%p=1"
        echo   [WARN] !SVC! port !PORT! in use - PID %%p - killing ...
        taskkill /F /PID %%p 2>nul
        if errorlevel 1 echo   [WARN] Failed to kill PID %%p. Check permissions or kill manually.
    )
)
exit /b 0
