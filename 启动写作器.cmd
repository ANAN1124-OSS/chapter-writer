@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\start.js
if errorlevel 1 (
  echo.
  echo 章节写作器启动失败，退出码 %errorlevel%。
  echo 请把上面的错误信息发给开发者。
  pause
)
