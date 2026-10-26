@echo off
REM Double-click to start OneISP (http://localhost:8080) and SmartOLT (http://localhost:4000)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS from https://nodejs.org & pause & exit /b 1)
if not exist config.local.json (
  echo First start: enter your Safaricom Daraja keys once. They are saved only on this PC.
  node setup.js
)
start "" http://localhost:8080
start "" http://localhost:4000
node start-all.js
pause
