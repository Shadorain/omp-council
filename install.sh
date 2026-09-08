#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-${OMP_AGENT_DIR:-$HOME/.omp/agent}}"
EXT_DIR="$AGENT_DIR/extensions/omp-council"
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$EXT_DIR/src" "$AGENT_DIR/agents"
cp "$ROOT/index.ts" "$EXT_DIR/index.ts"
cp "$ROOT/src/"*.ts "$EXT_DIR/src/"

echo "Installed omp-council to: $EXT_DIR"
echo "Saved model registry will be created on first /council or /arena at: ${OMP_COUNCIL_CONFIG:-$AGENT_DIR/council.json}"
echo "Use /council -t or /arena -t for one-run model selection without saving the registry."
echo "Restart OMP if this is the first installation."
