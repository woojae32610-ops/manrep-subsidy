@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 링크 점검 (신청 페이지·정부24 원문이 열리는지) — 몇 분 걸려요
call node src\checklinks.js --all || goto :err
call node src\build.js || goto :err
echo.
echo 완료. 죽은 링크는 사이트에서 숨겨지고 안내 문구가 떠요. 의심 링크는 내일 다시 확인해요.
pause
exit /b 0
:err
echo.
echo 실패했어요. 위 메시지를 확인하세요.
pause
exit /b 1
