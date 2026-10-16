#!/usr/bin/env bash
# macOS / Linux launcher. Run with:  bash start.sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  cat <<'MSG'

  Node.js is not installed on this machine.

  Install it once, then run this again:

    macOS   brew install node
    Ubuntu  sudo apt install nodejs   (needs 22.5+, else use https://nodejs.org)
    any OS  https://nodejs.org  (download the LTS installer)

  Nothing else is needed - no npm install, no packages.

MSG
  exit 1
fi

echo
echo "  MSOTRA GAMEPLAY LAB - Grid Guardians"
echo "  Open http://localhost:7788 in your browser."
echo "  Press Ctrl+C to stop."
echo
exec node --no-warnings server.mjs
