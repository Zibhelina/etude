@echo off
rem The etude command that comes with the desktop app: the app's own engine, run by Etude.exe in Node mode.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\..\..\Etude.exe" "%~dp0..\..\bin\etude.js" %*
