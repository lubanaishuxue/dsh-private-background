@echo off
setlocal
rem GBK 存盘 + 显式声明代码页：cmd 按当前代码页解析每条命令行，
rem 所以这一行之前必须只有 ASCII。
chcp 936 >nul
title 修复费用弹窗玻璃
color 07

rem ==========================================================================
rem  双击这个文件：把 cost-meter 弹窗的玻璃效果补回去。
rem
rem  为什么需要它：费用明细弹窗的底色写在 cost-meter 自己的样式表里，末尾带着
rem  一个 "/ 1" 把 alpha 强行压回不透明，所以从外面改不到 —— 只能改它自己的文件。
rem  代价是它每次升级都会把补丁冲掉。
rem
rem  正常情况下不用管这个文件：插件自己在装配时、运行中（含更新撞车的那几百
rem  毫秒）、以及每次登录都会补。这里只是万一全都失手时的手动兜底。
rem ==========================================================================

echo.
echo   ============================================
echo     修复费用明细弹窗的玻璃效果
echo   ============================================
echo.

rem ---- 找 node：先找固定的两个，再退回 PATH ---------------------------------
set "NODE="
if exist "C:\Users\25315\.codearts\runtimes\node\node.exe" set "NODE=C:\Users\25315\.codearts\runtimes\node\node.exe"
if not defined NODE if exist "C:\Users\25315\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=C:\Users\25315\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"

if not defined NODE (
  echo   [x] 找不到 node.exe。
  echo       这台机器上应该有的，可能被卸载或挪走了。
  goto :end
)

set "HEAL=D:\dsh-plugins\custom-background\tools\cost-meter-heal.mjs"
if not exist "%HEAL%" (
  echo   [x] 找不到修复脚本：
  echo       %HEAL%
  echo       插件目录可能被移走了。
  goto :end
)

rem ---- 判断 DSH 是否在跑（进程显示名是 "DeepSeek Harness.exe"）--------------
set "RUNNING="
tasklist /fi "imagename eq DeepSeek Harness.exe" 2>nul | findstr /i "DeepSeek" >nul 2>&1 && set "RUNNING=1"

rem ---- 跑一次 ---------------------------------------------------------------
"%NODE%" "%HEAL%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed
echo.

echo   [ok] 补丁已经在文件里了。
echo.
if defined RUNNING (
  echo   注意：DSH 现在开着，已经加载进页面的样式不会自己重新读文件。
  echo   要让玻璃效果真的回来，二选一：
  echo.
  echo     1. 在 DSH 窗口里按 Ctrl + R 刷新   ^(快，先试这个^)
  echo     2. 完全退出 DSH 再打开
  echo.
) else (
  echo   DSH 当前没在运行，下次打开就是玻璃效果的。
)
goto :end

:failed
echo   [x] 没能补上。上面那行说明原因，常见的是：
echo       - cost-meter 新版本改了样式写法，补丁的定位锚点失效
echo       - 文件正被占用
echo.
echo   把上面那行发给我，我来改锚点。

:end
echo.
echo   --------------------------------------------
echo   日志：%USERPROFILE%\.dsh\dshbg-cost-meter-heal.log
echo   --------------------------------------------
echo.
pause
