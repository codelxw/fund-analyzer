@echo off
chcp 65001 >nul
echo 正在启动局域网访问服务...
cd /d "%~dp0"
start "" http://localhost:8899
node serve.js
pause
