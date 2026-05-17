@echo off
cd /d "%~dp0"

set HOST=127.0.0.1
set PORT=8000
set RELOAD=1

echo ========================================
echo   S-57 Web Viewer
echo ========================================
echo.

where python >nul 2>&1
if errorlevel 1 goto nopython

if exist ".venv\Scripts\activate.bat" call ".venv\Scripts\activate.bat"

python -c "import fastapi, uvicorn, pyogrio" >nul 2>&1
if errorlevel 1 goto installdeps

goto startserver

:installdeps
echo Installing dependencies...
python -m pip install -r requirements.txt
if errorlevel 1 goto installfail

:startserver
if not exist "static\s52-preslib.json" goto buildpreslib
goto runserver

:buildpreslib
echo Building S-52 presentation library...
python scripts\build_preslib.py
if errorlevel 1 goto buildfail

:runserver
echo Starting server: http://%HOST%:%PORT%
echo Press Ctrl+C to stop.
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://%HOST%:%PORT%/"

python server.py
goto end

:nopython
echo ERROR: Python not found. Install Python 3.10 or newer and add it to PATH.
pause
exit /b 1

:installfail
echo ERROR: pip install failed.
pause
exit /b 1

:buildfail
echo ERROR: build_preslib.py failed.
pause
exit /b 1

:end
if errorlevel 1 pause
exit /b %ERRORLEVEL%
