# nostr-dag

DAG-based optimistic consensus for Nostr federations.

**BTC++ Taipei 2025 Hackathon Entry** - Built during a vibe coding session with Claude.

## What is this?

A proof-of-concept showing how a federation of Nostr keypairs can achieve consensus on message ordering using a DAG (Directed Acyclic Graph) structure. Messages become "canonical" once a majority of federation members have acknowledged them.

## How it works

1. Users send chat messages (NIP-28 Kind 42) to a relay
2. Federation daemons subscribe to these messages
3. Each daemon publishes acknowledgment events (Kind 21000) referencing the messages
4. Messages transition from "pending" to "canonical" once >50% of federation members have acked
5. The frontend shows this transition in real-time

## Running the demo

```bash
# Build, test, or generate the Pages site
just build
just test
just site

# Or use Make
make build
make test
make site

# Start relay + 5 federation daemons
just demo

# Open in browser
firefox demo/index.html
```

Click "Connect", then send messages. Watch them go from pending (gray) to canonical (green) as acks arrive.

## Project structure

- `src/dag.rs` - Core DAG with pending event buffering
- `src/bin/federation.rs` - Federation daemon
- `src/bin/relay.rs` - Local relay for demo
- `demo/index.html` - Browser frontend
- `demo/run.sh` - Demo launcher script

## Dependencies

Requires the [rust-nostr](https://github.com/rust-nostr/nostr) SDK as a sibling directory at `../nostr`.
