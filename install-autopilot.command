#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
LABEL="com.ujjwal.job-agent"
SOURCE_PLIST="$PROJECT_DIR/launchd/$LABEL.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
INSTALL_DIR="$HOME/Library/Application Support/Job Hunt Agent"
DOMAIN="gui/$(id -u)"

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/data" "$TARGET_DIR"

# Deploy a runtime copy outside Desktop so macOS background privacy controls do
# not block launchd. Preserve the installed tracker on subsequent upgrades.
for item in src public; do
  mkdir -p "$INSTALL_DIR/$item"
  rsync -a --delete "$PROJECT_DIR/$item/" "$INSTALL_DIR/$item/"
done
if [[ -d "$INSTALL_DIR/extension" ]]; then
  mv "$INSTALL_DIR/extension" "$HOME/.Trash/Job Hunt Agent extension $(date +%Y%m%d-%H%M%S)"
fi
for item in Resumes node_modules .runtime; do
  rsync -a "$PROJECT_DIR/$item" "$INSTALL_DIR/"
done
for item in package.json package-lock.json tsconfig.json profile.json sources.json .env job-agent-service.command open-chrome.command install-autopilot.command; do
  cp "$PROJECT_DIR/$item" "$INSTALL_DIR/$item"
done
if [[ -z "$(find "$INSTALL_DIR/data" -mindepth 1 -maxdepth 1 -print -quit)" && -d "$PROJECT_DIR/data" ]]; then
  rsync -a "$PROJECT_DIR/data/" "$INSTALL_DIR/data/"
fi
chmod 600 "$INSTALL_DIR/.env" "$INSTALL_DIR/profile.json" "$INSTALL_DIR/sources.json"
chmod 755 "$INSTALL_DIR/job-agent-service.command" "$INSTALL_DIR/open-chrome.command" "$INSTALL_DIR/install-autopilot.command"

sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$SOURCE_PLIST" > "$TARGET_PLIST"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if ! launchctl bootstrap "$DOMAIN" "$TARGET_PLIST" >/dev/null 2>&1; then
  sleep 1
  launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"
fi
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Job Agent screening service is installed and running in the background."
echo "Dashboard: http://127.0.0.1:4317"
"$PROJECT_DIR/open-chrome.command" "http://127.0.0.1:4317"
