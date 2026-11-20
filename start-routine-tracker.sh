#!/usr/bin/env bash
set -euo pipefail

# Run from the Routine Tracker project folder, regardless of the current directory.
cd "$(dirname "$0")"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "ERROR: Tailscale CLI is not available in this Debian session."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not available."
  exit 1
fi

echo "Configuring Tailscale Funnel for Routine Tracker..."
tailscale funnel reset
tailscale funnel --https=443 --set-path=/ --bg http://127.0.0.1:4317

echo "Starting Routine Tracker..."
exec npm start
