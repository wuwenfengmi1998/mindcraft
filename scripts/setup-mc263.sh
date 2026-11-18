#!/usr/bin/env bash
set -euo pipefail

MINEFLAYER_SHA="ad4af12611fd55309bb387b2b416212bffb0eddf"
PROTOCOL_SHA="3473413d32ee09af55aa77579000391be3bb9753"
CHUNK_SHA="a96fd7050163b5ae3cbce240deab453a03cd3bc2"
PHYSICS_SHA="b928638645a56a110a51da1f2080c6455b27984a"
DATA_SHA="312f3cada17a7d9e2e1a1834fe26f17296163096"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
    npm install
fi

npm install --no-save --ignore-scripts \
    "github:suisarbre/mineflayer#${MINEFLAYER_SHA}" \
    "github:suisarbre/node-minecraft-protocol#${PROTOCOL_SHA}" \
    "github:suisarbre/prismarine-chunk#${CHUNK_SHA}" \
    "github:DallasCarraher/prismarine-physics#${PHYSICS_SHA}"

if ! grep -q "updateLavaAvoidance" node_modules/mineflayer-pathfinder/index.js 2>/dev/null; then
    npx patch-package
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MCDATA_DIR="node_modules/minecraft-data/minecraft-data"
curl -fL "https://codeload.github.com/suisarbre/minecraft-data/tar.gz/${DATA_SHA}" -o "$TMP_DIR/minecraft-data.tar.gz"
tar -xzf "$TMP_DIR/minecraft-data.tar.gz" -C "$TMP_DIR"

rm -rf "$MCDATA_DIR"
mv "$TMP_DIR/minecraft-data-${DATA_SHA}" "$MCDATA_DIR"

(
    cd node_modules/minecraft-data
    node bin/generate_data.js
)

node scripts/verify-mc263.cjs
