@echo off
chcp 65001 >nul
title J.A.R.V.I.S. Mark VII - Stark Industries OS
cd /d "%~dp0"
echo ============================================================
echo    J.A.R.V.I.S. MARK VII BASLATILIYOR...
echo    (Canli ekran goruntusu icin bu pencere acik kalmalidir)
echo ============================================================

rem Eski JARVIS sunucusu 7777 portunu tutuyorsa kapat (canli ekran icin sunucu SIZIN masaustu oturumunuzda calismali)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777 " ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul

start "" cmd /c "timeout /t 3 /nobreak >nul & start "" chrome.exe http://localhost:7777 || start "" http://localhost:7777"
node server.js
pause
