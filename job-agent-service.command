#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"
mkdir -p data
export PATH="$PROJECT_DIR/.runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec npm run dashboard
