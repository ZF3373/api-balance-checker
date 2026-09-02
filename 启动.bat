@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 API 余额查询...
npx electron . --no-sandbox
