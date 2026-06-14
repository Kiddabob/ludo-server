@echo off
setlocal

set "REPO_DIR=G:\K Website\Ludo"
set "DEFAULT_COMMIT_MSG=Polish seat layout and dice roll animation"

title Push Ludo Updates
echo.
echo Ludo update pusher
echo ==================
echo.

if not exist "%REPO_DIR%\.git" (
  echo Could not find a Git repository at:
  echo %REPO_DIR%
  echo.
  echo Make sure the Ludo GitHub repo is cloned there first.
  echo.
  pause
  exit /b 1
)

cd /d "%REPO_DIR%"

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found on your PATH.
  echo.
  echo Install Git for Windows, then reopen this file:
  echo https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo Current folder:
echo %CD%
echo.

git status --short
echo.

echo Default update description:
echo %DEFAULT_COMMIT_MSG%
echo.
set "COMMIT_MSG="
set /p "COMMIT_MSG=Update description (type your own, or press Enter to use the default): "
if "%COMMIT_MSG%"=="" set "COMMIT_MSG=%DEFAULT_COMMIT_MSG%"

echo.
echo Staging files...
git add .
if errorlevel 1 goto failed

echo.
echo Creating commit...
git diff --cached --quiet
if not errorlevel 1 (
  echo No changes to commit.
) else (
  git commit -m "%COMMIT_MSG%"
  if errorlevel 1 goto failed
)

echo.
echo Pushing to GitHub...
git push
if errorlevel 1 goto failed

echo.
echo Done. Render should start deploying from GitHub shortly.
echo.
pause
exit /b 0

:failed
echo.
echo Something went wrong. The messages above should explain what Git needs.
echo.
pause
exit /b 1
