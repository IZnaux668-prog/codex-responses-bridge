@echo off
chcp 65001 >nul
echo Starting Codex Responses Local Bridge on http://127.0.0.1:18787/v1 ...
node "%~dp0server.mjs"
pause
