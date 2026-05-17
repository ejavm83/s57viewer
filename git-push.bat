@echo off
cd /d "%~dp0"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto nogit

echo ========================================
echo   S-57 Viewer - Git commit and push
echo ========================================
echo.

git status --short
echo.

if "%~1"=="" goto askmsg
set "MSG=%*"
goto domsg

:askmsg
set /p MSG=Commit message: 

:domsg
if "%MSG%"=="" goto empty

git add -A
git diff --cached --quiet
if errorlevel 1 goto docommit
echo No staged changes. Push only.
goto dopush

:docommit
echo Commit: %MSG%
git commit -m "%MSG%"
if errorlevel 1 goto commitfail

:dopush
echo Push to origin...
git push -u origin HEAD
if errorlevel 1 goto pushfail

echo Done.
pause
exit /b 0

:nogit
echo ERROR: Not a git repository.
pause
exit /b 1

:empty
echo ERROR: Empty commit message.
pause
exit /b 1

:commitfail
echo ERROR: Commit failed.
pause
exit /b 1

:pushfail
echo ERROR: Push failed. Check remote and login.
pause
exit /b 1
