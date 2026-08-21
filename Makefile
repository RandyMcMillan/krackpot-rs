.DEFAULT_GOAL := help

CARGO ?= cargo
WASM_PACK ?= wasm-pack
GH ?= gh
BRANCH ?= $(shell git branch --show-current)
CARGO_TARGET_DIR ?= target

.PHONY: help build test build-relay build-server wasm site demo server clean deploy

help:
	@printf '%s\n' \
		'Targets:' \
		'  build       Build native library/binaries' \
		'  test        Run native tests' \
		'  build-relay Build relay + federation release binaries' \
		'  build-server Build the nostr-dag server binary' \
		'  wasm        Build the WASM package into site/pkg' \
		'  site        Build the GitHub Pages site' \
		'  demo        Run the local demo launcher' \
		'  server      Run the nostr-dag server' \
		'  clean       Remove build artifacts' \
		'  deploy      Build the site and trigger the Pages workflow'

build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --features native

test:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) test --features native

build-relay:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --release --bin relay --bin federation --features relay

build-server:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --bin nostr-dag-server --features native

wasm:
	LLVM_PATH=$$(brew --prefix llvm) && AR="$$LLVM_PATH/bin/llvm-ar" CC="$$LLVM_PATH/bin/clang" CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(WASM_PACK) build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
	mkdir -p site
	cp demo/index.html site/index.html

demo:
	./demo/run.sh

server:
	$(MAKE) build-server site
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) run --bin nostr-dag-server --features native

clean:
	$(CARGO) clean
	rm -rf pkg site

deploy:
	$(GH) workflow run "Deploy to GitHub Pages" --ref "$(BRANCH)"
