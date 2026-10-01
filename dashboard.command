#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"
export PATH="$PROJECT_DIR/.runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DASHBOARD_URL="http://127.0.0.1:4317"

if curl -fsS "$DASHBOARD_URL/api/state" >/dev/null 2>&1; then
  echo "Dashboard is already running at $DASHBOARD_URL"
  "$PROJECT_DIR/open-chrome.command" "$DASHBOARD_URL"
  exit 0
fi

echo "Starting Job Agent dashboard..."
npm run dashboard &
DASHBOARD_PID=$!
trap 'kill "$DASHBOARD_PID" 2>/dev/null || true' EXIT INT TERM

for attempt in {1..50}; do
  if curl -fsS "$DASHBOARD_URL/api/state" >/dev/null 2>&1; then
    echo "Opening $DASHBOARD_URL"
    "$PROJECT_DIR/open-chrome.command" "$DASHBOARD_URL"
    wait "$DASHBOARD_PID"
    exit 0
  fi
  sleep 0.2
done

if ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
  wait "$DASHBOARD_PID" || true
fi
echo "Dashboard did not start. Review the error shown above."
echo "You can also run this from Terminal:"
echo "cd '$PROJECT_DIR' && env PATH=\"$PROJECT_DIR/.runtime/bin:\$PATH\" npm run dashboard"
read "reply?Press Enter to close..."
exit 1
