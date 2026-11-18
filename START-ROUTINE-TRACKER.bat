@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Use the same default port as the app and the existing Google OAuth setup.
set "PORT=4317"
if exist ".env" (
  for /f "tokens=1,* delims==" %%A in ('findstr /b /i "PORT=" ".env"') do set "PORT=%%B"
)
if not defined PORT set "PORT=4317"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo Installing Routine Tracker dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed. Check the terminal output above.
    pause
    exit /b 1
  )
)

REM If the app is already running, reuse it rather than starting a duplicate server.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 2; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto OPEN_SITE

echo Starting Routine Tracker on port %PORT%...
start "Routine Tracker Server" cmd /k "cd /d ""%~dp0"" && set PORT=%PORT% && npm start"

set /a ATTEMPTS=0
:WAIT_FOR_SERVER
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 2; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto OPEN_SITE
set /a ATTEMPTS+=1
if %ATTEMPTS% GEQ 40 goto START_FAILED
timeout /t 1 /nobreak >nul
goto WAIT_FOR_SERVER

:OPEN_SITE
echo Routine Tracker is running. Opening your browser...
start "" "http://localhost:%PORT%"
exit /b 0

:START_FAILED
echo Routine Tracker did not start successfully.
echo Check the separate Routine Tracker Server window for the error message.
echo The browser was not opened because the server did not respond.
pause
exit /b 1
