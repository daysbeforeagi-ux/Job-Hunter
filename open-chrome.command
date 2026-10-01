#!/bin/zsh
set -e

CHROME_APP="/Applications/Google Chrome.app"
CHROME_BINARY="$CHROME_APP/Contents/MacOS/Google Chrome"
CHROME_PROFILE_DIRECTORY="${CHROME_PROFILE_DIRECTORY:-Profile 1}"
TARGET_URL="${1:-}"

case "$TARGET_URL" in
  http://*|https://*|chrome://extensions) ;;
  *) echo "A supported web address is required." >&2; exit 1 ;;
esac

if [[ -x "$CHROME_BINARY" ]]; then
  "$CHROME_BINARY" "--profile-directory=$CHROME_PROFILE_DIRECTORY" "$TARGET_URL" >/dev/null 2>&1 &
else
  open -a "Google Chrome" "$TARGET_URL"
fi
