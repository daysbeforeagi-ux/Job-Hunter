#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"
export PATH="$PROJECT_DIR/.runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PLAYWRIGHT_BROWSERS_PATH="$PROJECT_DIR/.runtime/playwright"

if [[ ! -f .env ]]; then
  echo "Gemini is not configured yet. The dashboard and tracking features still work."
  echo "To enable AI features, copy .env.example to .env and add GEMINI_API_KEY locally."
fi

echo ""
echo "Job Agent"
echo "1) Open web dashboard"
echo "2) Run discovery and ranking now"
echo "3) Show queue"
echo "4) Show today's progress"
echo "5) Run setup doctor"
read "choice?Choose 1-5: "

case "$choice" in
  1)
    "$PROJECT_DIR/dashboard.command"
    ;;
  2)
    npm start -- discover
    npm start -- scan --limit 50
    npm start -- queue --status ready
    ;;
  3)
    npm start -- queue
    ;;
  4)
    npm start -- stats
    ;;
  5)
    npm start -- doctor
    ;;
  *)
    echo "Invalid choice."
    exit 1
    ;;
esac

read "reply?Press Enter to close..."
