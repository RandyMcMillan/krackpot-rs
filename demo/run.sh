#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/federation.toml}"
PORT="${PORT:-8080}"

PIDS=()

cleanup() {
    echo ""
    echo "Shutting down..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
    echo "Done."
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

echo "Building..."
cargo build --release --bin relay --bin federation --features relay 2>&1 | grep -E "Compiling|Finished" || true

echo ""
echo "Reading federation config from $CONFIG_FILE..."

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE"
    echo "Generate one with: cargo run --bin keygen"
    exit 1
fi

SECRETS=($(grep 'secret_key' "$CONFIG_FILE" | sed 's/.*"\([^"]*\)".*/\1/'))
PUBKEYS=($(grep 'public_key' "$CONFIG_FILE" | sed 's/.*"\([^"]*\)".*/\1/'))

if [ ${#SECRETS[@]} -lt 1 ] || [ ${#PUBKEYS[@]} -lt 1 ]; then
    echo "Error: Failed to parse config file"
    exit 1
fi

FEDERATION_PUBKEYS=$(IFS=,; echo "${PUBKEYS[*]}")

echo ""
echo "Starting relay on port $PORT..."
PORT="$PORT" cargo run --release -q --bin relay --features relay &
PIDS+=($!)
sleep 1

RELAY_URL="ws://localhost:$PORT"
echo "Relay running at $RELAY_URL"

echo ""
echo "Starting ${#SECRETS[@]} federation daemons..."
for i in "${!SECRETS[@]}"; do
    FEDERATION_KEY="${SECRETS[$i]}" \
    RELAY_URL="$RELAY_URL" \
    FEDERATION_PUBKEYS="$FEDERATION_PUBKEYS" \
    RUST_LOG=federation=info \
    cargo run --release -q --bin federation &
    PIDS+=($!)
    echo "  Started daemon $((i+1)) (pid ${PIDS[-1]}, pubkey ${PUBKEYS[$i]:0:8}...)"
done

echo ""
echo "=== Demo Ready ==="
echo ""
echo "Relay: $RELAY_URL"
echo ""
echo "Open in browser: file://$SCRIPT_DIR/index.html"
echo ""
echo "Press Ctrl+C to stop"
echo ""

wait
