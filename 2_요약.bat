@echo off
chcp 65001 >nul
cd /d "%~dp0"
set N=%1
if "%N%"=="" set N=5
echo AI 요약 %N%건만 (전부 돌리려면: 2_요약.bat all)
if "%N%"=="all" (call node src\summarize.js) else (call node src\summarize.js --limit %N%)
if errorlevel 1 goto :err
call node src\build.js || goto :err
echo.
echo 완료. data\review.md 와 site\index.html 을 확인하세요.
pause
exit /b 0
:err
echo.
echo 실패했어요. 위 메시지를 확인하세요.
pause
exit /b 1
