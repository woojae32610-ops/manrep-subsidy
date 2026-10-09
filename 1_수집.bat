@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/2] 정부24 수집
call node src\collect.js || goto :err
echo [2/2] 사이트 생성
call node src\build.js || goto :err
echo.
echo 완료. data\field-report.md 와 site\index.html 을 확인하세요.
pause
exit /b 0
:err
echo.
echo 실패했어요. 위 메시지를 확인하세요.
pause
exit /b 1
