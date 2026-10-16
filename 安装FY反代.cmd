@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\install.ps1" -OpenBrowser %*
set "FY_INSTALL_EXIT=%ERRORLEVEL%"
pause
exit /b %FY_INSTALL_EXIT%
