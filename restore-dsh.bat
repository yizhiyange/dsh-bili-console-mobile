@echo off
chcp 65001 >nul
echo ============================================
echo   一键撤销：把「刷视频」插件从 DSH 移除
echo ============================================
echo.

rem 优先用系统 PATH 里的 node；没有再找常见安装位置
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo [x] 没找到 node.exe。
  echo     请先安装 Node.js 18+：https://nodejs.org/
  echo     装好之后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo 使用 Node："%NODE_EXE%"
"%NODE_EXE%" "%~dp0restore-dsh.mjs"
echo.
echo 完成后重启 DSH 即可恢复原状。
pause
