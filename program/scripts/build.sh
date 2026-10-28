#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p target/deploy target/mainnet target/devnet target/checks
NO_DNA=1 anchor build --ignore-keys
mkdir -p target/mainnet target/devnet
cp target/deploy/span.so target/mainnet/span.so
cp target/idl/span.json target/mainnet/span.json
NO_DNA=1 npm run generate
NO_DNA=1 anchor build --ignore-keys -- --features devnet
cp target/deploy/span.so target/devnet/span.so
cp target/idl/span.json target/devnet/span.json
cp target/mainnet/span.so target/deploy/span.so
cp target/mainnet/span.json target/idl/span.json
