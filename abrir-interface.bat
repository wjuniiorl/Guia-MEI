@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Abrindo a interface do Guia-MEI...
python app.py
if errorlevel 1 (
  echo.
  echo Se deu erro, verifique:
  echo   1) Python instalado ^(https://www.python.org^)
  echo   2) Dependencia instalada:  pip install customtkinter
  echo   3) Node.js instalado ^(https://nodejs.org^)
  pause
)
