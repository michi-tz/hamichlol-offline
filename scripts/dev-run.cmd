@echo off
REM This script launches the hamichlol-offline app in dev mode for dry run testing

REM Set the development mode flag
set DEV_MODE=true

echo Starting hamichlol-offline in DEV MODE
echo This will simulate server operations without actually downloading large files

REM Run the Electron app
npm start
