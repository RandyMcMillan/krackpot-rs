# Copilot instructions for `nostr-dag`

## Build, test, and run

- Native build: `just build` or `make build`
- Native tests: `just test-native` / `make test-native` / `cargo test --features native`
- JS tests: `just test-js` / `make test-js` / `node --test test/*.test.mjs`
- Full test pass: `just test` or `make test`
- Release relay + federation binaries: `just build-relay` / `make build-relay`
- Native server binary: `just build-server` / `make build-server`
- Build the browser site: `just site`
- Run the local demo: `just demo`
- Run the local static server: `just server`
- Single Rust test: `cargo test --features native <test_name>`
- Single JS test file: `node --test test/<file>.test.mjs`

The repo expects the `rust-nostr` SDK as a sibling checkout at `../nostr`.

## Big picture

- `src/dag.rs` is the core state machine: it stores events, buffers arrivals with missing parents, computes depth, tracks children/tips, and decides canonicality.
- Canonicality is a 4/5 quorum rule, not a simple majority: `Dag::is_canonical` checks whether `seen_by.len() > threshold`, and the threshold is derived from participant count.
- `src/event.rs` defines the DAG ack event kind (`Kind::Custom(21000)`) and helper functions for building/parsing parent tags.
- `src/bin/federation.rs` runs one federation daemon. It watches NIP-28 chat messages (`Kind::Custom(42)`) plus DAG ack events, updates local DAG state, and publishes acks after new messages.
- `src/bin/relay.rs`, `src/bin/keygen.rs`, and `src/bin/krackpot-server.rs` support the local demo workflow.
- `src/lib.rs` also exposes a wasm wrapper (`WasmDag`) when the `wasm` feature is enabled.
- `demo/` contains the browser UI and the Git viewer; `demo/shared/` holds reusable browser helpers.
- `demo/krackpot/index.html` is the self-hosted Krackpot app shell that boots the mirrored `src/` tree.
- `demo/krackpot/source/index.html` is the local source browser for the mirrored Krackpot files.
- `site/` is generated output: `wasm-pack` writes `site/pkg`, and the site build copies the demo HTML/assets into `site/`.
- The local server serves `.mjs` as `text/javascript` so the static preview and GitHub Pages behave the same.

## Conventions to preserve

- Keep shared browser chrome in sync between the demo and Git viewer by updating `demo/shared/page-header.mjs` and `demo/shared/logger-footer.js`, then copying behavior into `site/` via the existing build steps.
- Add new top-level tabs in the shared header nav on every page that uses it, including the Krackpot wrapper page.
- JS tests use Node’s built-in test runner and load source files directly from `demo/shared/` with `data:` URLs; follow that style for new browser-helper tests.
- The demo and Git viewer both rely on the shared logger footer for trace/progress output; `demo/shared/git-progress.mjs` deduplicates repeated clone/fetch updates and should stay aligned with the UI.
- Asset paths are relative to the demo/site layout (`./shared/...`, `../shared/...`); keep route changes compatible with the local file server and Pages.
- `demo/run.sh` expects `demo/federation.toml` and starts the relay plus federation daemons with environment variables for keys, relay URL, and pubkey list.
- Prefer the existing cargo features: `native` for server/daemon code, `relay` for the relay + federation binaries, and `wasm` for the browser wrapper.
