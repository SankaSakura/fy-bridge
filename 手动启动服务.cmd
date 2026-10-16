@echo off
chcp 65001 >nul
setlocal
where node >nul 2>nul
if errorlevel 1 goto missing_node
echo 正在手动启动 FY 本地服务，请保持此窗口打开。
echo 请在浏览器中打开 FY 本地反代扩展，然后点击“启动反代”。
echo 如需关闭服务，请在此窗口按 Ctrl+C。
node "%~dp0server.mjs" %*
set "FY_SERVICE_EXIT=%ERRORLEVEL%"
echo.
echo 本地服务已退出，退出代码为 %FY_SERVICE_EXIT%。
pause
exit /b %FY_SERVICE_EXIT%
:missing_node
echo 未找到 Node.js。请从 https://nodejs.org/ 安装 Node.js 22 或更高版本。
pause
exit /b 1
