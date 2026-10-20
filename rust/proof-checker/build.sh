#!/bin/sh
# Builds the pinned proof-mining kernel checker: nanoda_lib at the revision
# fixed in PROOF_CHECK_PROFILE_V1, plus NIR's deterministic step limit.
# Usage: sh rust/proof-checker/build.sh <output directory>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?output directory required}
revision=f67473ba5f9397266f89c7852082c9c914b5d219
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q
git -C "$work" fetch -q --depth 1 https://github.com/ammkrn/nanoda_lib "$revision"
git -C "$work" checkout -q FETCH_HEAD
git -C "$work" apply "$here/nanoda-step-limit.patch"
cargo build --locked --release --manifest-path "$work/Cargo.toml"
cp "$work/target/release/nanoda_bin" "$out/nanoda_bin"
echo "$out/nanoda_bin"
