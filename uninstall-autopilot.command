#!/bin/zsh
set -e

LABEL="com.ujjwal.job-agent"
TARGET_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if [[ -f "$TARGET_PLIST" ]]; then
  mv "$TARGET_PLIST" "$HOME/.Trash/$LABEL.plist"
fi
echo "Job Agent background service was stopped and its plist was moved to Trash."
echo "Its private runtime and tracker remain in ~/Library/Application Support/Job Hunt Agent for recovery."
