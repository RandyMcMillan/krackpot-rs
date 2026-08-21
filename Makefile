.DEFAULT_GOAL := help

CARGO ?= cargo
WASM_PACK ?= wasm-pack
GH ?= gh
BRANCH ?= $(shell git branch --show-current)
CARGO_TARGET_DIR ?= target

.PHONY: help build test build-relay wasm site demo clean deploy

help:
	@printf '%s\n' \
		'Targets:' \
		'  build       Build native library/binaries' \
		'  test        Run native tests' \
		'  build-relay Build relay + federation release binaries' \
		'  wasm        Build the WASM package into site/pkg' \
		'  site        Build the GitHub Pages site' \
		'  demo        Run the local demo launcher' \
		'  clean       Remove build artifacts' \
		'  deploy      Build the site and trigger the Pages workflow'

build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --features native

test:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) test --features native

build-relay:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --release --bin relay --bin federation --features relay

wasm:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(WASM_PACK) build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
	mkdir -p site
	cp demo/index.html site/index.html

demo:
	./demo/run.sh

clean:
	$(CARGO) clean
	rm -rf pkg site

deploy:
	$(GH) workflow run "Deploy to GitHub Pages" --ref "$(BRANCH)"
