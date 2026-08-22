set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    just --list

build:
    CARGO_TARGET_DIR=target cargo build --features native

test:
    just test-native
    just test-js

test-all:
    just test-native
    just test-js

test-native:
    CARGO_TARGET_DIR=target cargo test --features native

test-js:
    node --test test/*.test.mjs

build-relay:
    CARGO_TARGET_DIR=target cargo build --release --bin relay --bin federation --features relay

build-server:
    CARGO_TARGET_DIR=target cargo build --bin nostr-dag-server --features native

wasm:
    LLVM_PATH=$(brew --prefix llvm) && AR="$LLVM_PATH/bin/llvm-ar" CC="$LLVM_PATH/bin/clang" CARGO_TARGET_DIR=target wasm-pack build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
    mkdir -p site
    cp demo/index.html site/index.html
    mkdir -p site/shared
    cp demo/shared/*.js demo/shared/*.mjs site/shared/
    mkdir -p site/git
    cp demo/git/index.html site/git/index.html

demo:
    ./demo/run.sh

server: build-server site
    CARGO_TARGET_DIR=target cargo run --bin nostr-dag-server --features native

clean:
    cargo clean
    rm -rf pkg site

deploy:
    branch=$(git branch --show-current) && gh workflow run "Deploy to GitHub Pages" --ref "$branch"
