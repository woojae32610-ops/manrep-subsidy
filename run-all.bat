@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 수집
call node src\collect.js || goto :err
echo [2/3] AI 요약
call node src\summarize.js || goto :err
echo [3/3] 사이트 생성
call node src\build.js || goto :err
echo.
echo 완료. site\index.html 을 열어보세요.  (미리보기 서버: npm run serve)
pause
exit /b 0
:err
echo.
echo 실패했어요. 위 메시지를 확인하세요.
pause
exit /b 1
