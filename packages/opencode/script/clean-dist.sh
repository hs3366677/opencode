#!/bin/bash
# Clean the dist/ directory while preserving node_modules/ and services/
# inside dist/opencode-windows-x64/ (local provider packages).
#
# Usage: bash script/clean-dist.sh

DIST_DIR="dist"
PLATFORM_DIR="$DIST_DIR/opencode-windows-x64"

if [ ! -d "$DIST_DIR" ]; then
    exit 0
fi

# Remove everything in dist/ except the platform dir
find "$DIST_DIR" -mindepth 1 -maxdepth 1 ! -name 'opencode-windows-x64' -exec rm -rf {} +

# Inside the platform dir, remove everything except node_modules and services
if [ -d "$PLATFORM_DIR" ]; then
    find "$PLATFORM_DIR" -mindepth 1 -maxdepth 1 \
        ! -name 'node_modules' \
        ! -name 'services' \
        -exec rm -rf {} +
fi
