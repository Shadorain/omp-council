#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-${OMP_AGENT_DIR:-$HOME/.omp/agent}}"
EXT_DIR="$AGENT_DIR/extensions/omp-council"
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/agents"

if [ "$ROOT" = "$EXT_DIR" ]; then
	echo "OMP already loads this checkout: $EXT_DIR"
else
	if [ "${OMP_COUNCIL_COPY:-}" = "1" ]; then
		mkdir -p "$EXT_DIR/src"
		cp "$ROOT/index.ts" "$EXT_DIR/index.ts"
		cp "$ROOT/src/"*.ts "$EXT_DIR/src/"
		echo "Copied omp-council to: $EXT_DIR"
	else
		if [ -e "$EXT_DIR" ] && [ ! -L "$EXT_DIR" ]; then
			rm -rf "$EXT_DIR"
		fi
		ln -sfn "$ROOT" "$EXT_DIR"
		echo "Linked omp-council -> $EXT_DIR"
	fi
fi

echo "Saved model registry: ${OMP_COUNCIL_CONFIG:-$AGENT_DIR/council.json}"
echo "Restart OMP so it reloads the extension."
