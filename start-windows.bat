@echo off
REM Double-click to start OneISP (http://localhost:3000) and SmartOLT (http://localhost:4000)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS from https://nodejs.org & pause & exit /b 1)
start "" http://localhost:3000
start "" http://localhost:4000
node start-all.js
pause
