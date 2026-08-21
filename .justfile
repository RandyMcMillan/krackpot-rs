set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    just --list

build:
    CARGO_TARGET_DIR=target cargo build --features native

test:
    CARGO_TARGET_DIR=target cargo test --features native

build-relay:
    CARGO_TARGET_DIR=target cargo build --release --bin relay --bin federation --features relay

wasm:
    CARGO_TARGET_DIR=target wasm-pack build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
    mkdir -p site
    cp demo/index.html site/index.html

demo:
    ./demo/run.sh

clean:
    cargo clean
    rm -rf pkg site

deploy:
    branch=$(git branch --show-current) && gh workflow run "Deploy to GitHub Pages" --ref "$branch"
