#!/bin/bash
# Generate 5 federation keys for the demo

echo "Generating 5 federation keys..."
echo ""

PUBKEYS=""

for i in 1 2 3 4 5; do
  # Generate a random 32-byte hex key
  SECRET=$(openssl rand -hex 32)

  # Use nostr tools to get pubkey (or we can compute it)
  # For simplicity, just output the secret keys
  echo "=== Federation Member $i ==="
  echo "Secret key (hex): $SECRET"

  if [ -n "$PUBKEYS" ]; then
    PUBKEYS="$PUBKEYS,"
  fi
  # We'll need to compute pubkeys separately
  echo ""
done

echo "To get pubkeys, run each daemon once and note the pubkey from the logs."
echo ""
echo "Example daemon startup:"
echo "  FEDERATION_KEY=<secret_hex> RELAY_URL=ws://localhost:8080 FEDERATION_PUBKEYS=<pk1>,<pk2>,<pk3>,<pk4>,<pk5> cargo run --bin federation"
