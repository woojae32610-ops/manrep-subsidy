@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  GitHub 에 처음 올리기
echo  ---------------------------------------------
echo  미리 GitHub 에서 빈 저장소(Public)를 만들어 두세요. README 체크는 하지 마세요.
echo  예: https://github.com/아이디/manrep-subsidy
echo.
set /p REPO=저장소 주소 붙여넣기: 
if "%REPO%"=="" ( echo 주소가 비었어요. & pause & exit /b 1 )
git --version >nul 2>&1 || ( echo git 이 설치돼 있지 않아요. https://git-scm.com/download/win 에서 설치 후 다시 실행하세요. & pause & exit /b 1 )
if not exist .git git init
rem 커밋 작성자 (없으면 설정) — 공개 저장소라 GitHub 가림용 이메일 사용
git config user.name >nul 2>&1 || git config user.name "woojae32610-ops"
git config user.email >nul 2>&1 || git config user.email "woojae32610-ops@users.noreply.github.com"
git add -A
git commit -m "manrep-subsidy: 첫 업로드" || echo (이미 커밋돼 있거나 바뀐 게 없어요)
git branch -M main
git remote remove origin >nul 2>&1
git remote add origin %REPO%
echo.
echo  올리는 중... (처음이면 GitHub 로그인 창이 떠요)
git push -u origin main || ( echo. & echo 올리기 실패. 위 메시지를 캡처해 주세요. & pause & exit /b 1 )
echo.
echo  완료! 이제 GitHub 저장소 페이지에서:
echo   1) Settings ^> Secrets and variables ^> Actions ^> New repository secret 로 GOV24_API_KEY, ANTHROPIC_API_KEY 등록
echo   2) Settings ^> Pages ^> Source 를 "GitHub Actions" 로
echo   3) Actions 탭 ^> daily ^> Run workflow
pause
