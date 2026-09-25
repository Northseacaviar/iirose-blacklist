@echo off
chcp 65001 >nul
echo ==========================================================
echo   iirose 拉黑插件 - 本地托管（调试用）
echo.
echo   注入地址（复制到 iirose 页面 console 的 js 地址框里）：
echo     http://127.0.0.1:8770/src/iirose-blacklist.js
echo.
echo   联调 harness（自查用）：
echo     http://127.0.0.1:8770/tests/harness.html
echo.
echo   关掉这个窗口即停止托管
echo ==========================================================
python -m http.server 8770 --directory "%~dp0."
