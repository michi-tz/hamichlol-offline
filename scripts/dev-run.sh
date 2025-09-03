#!/bin/bash

# This script launches the hamichlol-offline app in dev mode for dry run testing

# Set the development mode flag
export DEV_MODE=true

echo "Starting hamichlol-offline in DEV MODE"
echo "This will simulate server operations without actually downloading large files"

# Run the Electron app
npm start
