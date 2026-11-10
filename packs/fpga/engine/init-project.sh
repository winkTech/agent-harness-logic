#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <project_name> [device]" >&2
  exit 1
fi

PROJECT_NAME="$1"
DEVICE="${2:-xc7k325tffg900-2}"

exec node "$SCRIPT_DIR/harness-init.cjs" --project "$PROJECT_NAME" --device "$DEVICE"
