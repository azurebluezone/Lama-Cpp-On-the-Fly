#!/usr/bin/env bash
# lama remote bootstrap - one command, no clone required.
#
#   curl -fsSL https://raw.githubusercontent.com/azurebluezone/Lama-Cpp-On-the-Fly/main/scripts/bootstrap.sh | bash
#
# It downloads Node 24 only when the machine has no v24+, fetches the lama
# source tarball from GitHub, overlays it into LAMA_DIR (default ~/lama) while
# preserving .env, data/, models/ and logs/, then runs the proven one-shot
# installer (scripts/install.mjs).
#
# Options:
#   --fetch-only        download + extract only; do not run the installer
#   --no-service        passed to install.mjs (skip systemd/launchd units)
#   --no-browser        passed to install.mjs (headless servers)
#   --build bNNNNN      passed to install.mjs (pin a llama.cpp release)
#   --accel cuda|vulkan passed to install.mjs (GPU build)
#
# Environment:
#   LAMA_REPO           GitHub owner/repo   (default azurebluezone/Lama-Cpp-On-the-Fly)
#   LAMA_REF            branch, tag or SHA  (default main)
#   LAMA_DIR            install directory   (default $HOME/lama)
#   LAMA_URL            override the source tarball URL
#
# Exit code 0 only when every step in this script and in install.mjs passed.
set -euo pipefail

REPO="${LAMA_REPO:-azurebluezone/Lama-Cpp-On-the-Fly}"
REF="${LAMA_REF:-main}"
DEST="${LAMA_DIR:-$HOME/lama}"
URL="${LAMA_URL:-https://github.com/${REPO}/archive/${REF}.tar.gz}"

FETCH_ONLY=0
INSTALL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --fetch-only) FETCH_ONLY=1 ;;
    *) INSTALL_ARGS+=("$arg") ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "lama bootstrap"
say "  repo : ${REPO}@${REF}"
say "  dest : ${DEST}"

# --- 1. transport tools ----------------------------------------------------
for tool in curl tar; do
  have "$tool" || die "missing '$tool'. Install it first: sudo apt install -y curl tar (or: sudo dnf install -y curl tar)"
done

sha256() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else die "need sha256sum or shasum to verify the Node download"
  fi
}

# --- 2. Node.js >= 24 ------------------------------------------------------
NODE_BIN=""
for candidate in "$(command -v node 2>/dev/null || true)" "$HOME/.local/node/bin/node"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  case "$major" in
    2[4-9]|[3-9][0-9]) NODE_BIN="$candidate"; break ;;
  esac
done

if [ -z "$NODE_BIN" ]; then
  say "  node : v24 not found, installing the official build (no sudo)"
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}/${arch}" in
    Linux/x86_64) node_os="linux"; node_arch="x64" ;;
    Linux/aarch64|Linux/arm64) node_os="linux"; node_arch="arm64" ;;
    Darwin/x86_64) node_os="darwin"; node_arch="x64" ;;
    Darwin/arm64) node_os="darwin"; node_arch="arm64" ;;
    *) die "unsupported platform ${os}/${arch}; install Node.js 24 manually and re-run" ;;
  esac
  index="$(curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)" ||
    die "cannot read the Node.js checksum list"
  file="$(printf '%s\n' "$index" | grep -oE "node-v24[0-9.]+-${node_os}-${node_arch}\.tar\.gz" | head -1)"
  [ -n "$file" ] || die "no Node.js 24 tarball for ${node_os}-${node_arch}"
  expected="$(printf '%s\n' "$index" | awk -v f="$file" '$2 == f { print $1 }')"
  tarball="${TMPDIR:-/tmp}/${file}"
  say "  node : downloading ${file}"
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v24.x/${file}" -o "$tarball" ||
    die "Node.js download failed"
  actual="$(sha256 "$tarball")"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "Node.js checksum mismatch for ${file}"
  mkdir -p "$HOME/.local"
  tar -xzf "$tarball" -C "$HOME/.local" || die "cannot extract ${file}"
  ln -sfn "$HOME/.local/${file%.tar.gz}" "$HOME/.local/node"
  rm -f "$tarball"
  NODE_BIN="$HOME/.local/node/bin/node"
  [ -x "$NODE_BIN" ] || die "Node.js install did not produce ${NODE_BIN}"
  rc="$HOME/.bashrc"
  [ -f "$rc" ] || rc="$HOME/.profile"
  if ! grep -q '\.local/node/bin' "$rc" 2>/dev/null; then
    printf '\nexport PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"\n' >> "$rc"
    say "  node : added ~/.local/node/bin to ${rc} (new shells only)"
  fi
fi
say "  node : $("$NODE_BIN" -v) (${NODE_BIN})"

# --- 3. fetch the source ---------------------------------------------------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/lama-bootstrap.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
archive="${tmp}/lama.tar.gz"
say "  fetch: ${URL}"
curl -fsSL --retry 3 --retry-delay 2 -o "$archive" "$URL" ||
  die "cannot download ${URL} (private repo? set LAMA_URL or use git clone)"
mkdir -p "${tmp}/src"
tar -xzf "$archive" -C "${tmp}/src" --strip-components=1 ||
  die "downloaded archive is not a valid tarball"
[ -f "${tmp}/src/package.json" ] && [ -f "${tmp}/src/src/main.ts" ] ||
  die "archive does not look like the lama repository"

# --- 4. overlay into the destination --------------------------------------
# Never delete .env, data/, models/ or logs/: a re-run is an update, not a reset.
# identity.json is runtime state with mode 0444; preserve it and let tar unlink
# read-only targets instead of failing like cp -a did.
mkdir -p "$DEST"
saved_identity=""
if [ -f "$DEST/identity.json" ]; then
  saved_identity="${tmp}/identity.json"
  cp -p "$DEST/identity.json" "$saved_identity" || true
  rm -f "$DEST/identity.json"
fi
tar -C "${tmp}/src" -cf - . | tar -C "$DEST" -xf - ||
  die "cannot overlay the downloaded tree into ${DEST}"
if [ -n "$saved_identity" ] && [ -f "$saved_identity" ]; then
  cp -p "$saved_identity" "$DEST/identity.json"
  chmod 0444 "$DEST/identity.json" 2>/dev/null || true
fi
[ -f "${DEST}/src/main.ts" ] || die "copy into ${DEST} failed"
say "  code : updated (kept .env, data/, models/, logs/, identity.json)"

if [ "$FETCH_ONLY" -eq 1 ]; then
  say "FETCH_OK ${DEST}"
  exit 0
fi

# --- 5. hand over to the proven installer ---------------------------------
cd "$DEST"
say ""
say "running scripts/install.mjs ${INSTALL_ARGS[*]:-}"
"$NODE_BIN" scripts/install.mjs ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}

say ""
say "DONE — gateway: http://127.0.0.1:5252 (admin UI at /admin, or the URL printed above)"
say "token: grep '^LAMA_ADMIN_TOKEN=' ${DEST}/.env"
