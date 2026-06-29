@echo off
title AGI Dashboard
cd /d "%~dp0"

REM ---- First run: install dependencies if they're missing -------------------
if not exist "node_modules" (
  echo Installing dependencies ^(first run only^)...
  call npm install || goto :fail
)
if not exist "web\node_modules" (
  echo Installing dashboard UI dependencies ^(first run only^)...
  call npm --prefix web install || goto :fail
)

echo.
echo ============================================================
echo   Launching the AGI dashboard...
echo   The browser will open automatically at http://localhost:4317
echo   Close this window or press Ctrl+C to stop.
echo ============================================================
echo.

call npm start

echo.
echo Dashboard stopped.
pause
exit /b 0

:fail
echo.
echo Setup failed. See the error above.
pause
exit /b 1
