@echo off
cd /d "%~dp0"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto nogit

echo ========================================
echo   S-57 Viewer - Git commit and push
echo ========================================
echo.

git status -sb
echo.
git status --short
echo.

git status --porcelain | findstr /r "." >nul 2>&1
if errorlevel 1 goto nochanges

if "%~1"=="" goto askmsg
set "MSG=%*"
goto docommit

:askmsg
set /p MSG=Commit message: 
if "%MSG%"=="" goto empty

:docommit
git add -A
git diff --cached --quiet
if errorlevel 1 goto commit
echo WARN: git add done but nothing staged.
goto dopush

:commit
echo Commit: %MSG%
git commit -m "%MSG%"
if errorlevel 1 goto commitfail

:dopush
echo.
echo Push to origin...
git push -u origin HEAD
if errorlevel 1 goto pushfail
echo.
echo Done. Remote is up to date.
goto end

:nochanges
echo INFO: No file changes. Commit skipped.
echo Latest on this PC:
git log -1 --oneline
echo.
echo Push to origin...
git push -u origin HEAD
if errorlevel 1 goto pushfail
echo.
echo Done. Nothing new to commit or push.
goto end

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

:end
pause
exit /b 0
