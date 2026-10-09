@echo off
chcp 65001 >nul
cd /d "%~dp0"
git add -A
git commit -m "update %date% %time%" || echo 바뀐 게 없어요.
git pull --rebase origin main
git push origin main
echo.
echo 완료. 몇 분 뒤 사이트에 반영돼요.
pause
