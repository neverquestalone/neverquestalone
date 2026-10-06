#!/bin/bash
# Downloads the Zig that build.sh is pinned to, for this machine, into a folder, checks the
# tarball's published SHA-256 (the values listed in build.sh's header, their one source) and prints
# ZIG=<path to zig>, ready for $GITHUB_ENV. The release job and test.yml's capture-windows job use
# it, so CI builds the helper exactly as a release does (systems plan Batch 1, SY-01).
#
#   bridge/capture/windows/fetch-zig.sh [folder]   (default: a new temp folder)
#
# Any other checksum is refused and the download deleted. With ZIG_TARBALL_CACHE set to a folder
# (test.yml keeps it between runs; ziglang.org is slow at times and the jobs time out), the
# tarball is kept there and used again, checked against the same SHA-256 every time: a cached
# tarball with any other checksum is deleted and downloaded again. A transfer that stalls (under
# 20 KB/s for 45 s) is dropped and retried.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/^ZIG_VERSION="\(.*\)"$/\1/p' "$HERE/build.sh")"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) NAME="zig-x86_64-linux-$VERSION" ;;
  Darwin-arm64) NAME="zig-aarch64-macos-$VERSION" ;;
  Darwin-x86_64) NAME="zig-x86_64-macos-$VERSION" ;;
  *) echo "no pinned zig for $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
WANT="$(awk -v f="$NAME.tar.xz" '$1 == "#" && $2 == f { print $3 }' "$HERE/build.sh")"
if ! [[ "$WANT" =~ ^[0-9a-f]{64}$ ]]; then echo "build.sh lists no SHA-256 for $NAME.tar.xz" >&2; exit 2; fi

DEST="${1:-$(mktemp -d)}"
mkdir -p "$DEST"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
CACHE="${ZIG_TARBALL_CACHE:-}"
if [ -n "$CACHE" ]; then mkdir -p "$CACHE"; TARBALL="$CACHE/$NAME.tar.xz"; else TARBALL="$DEST/$NAME.tar.xz"; fi
if [ -n "$CACHE" ] && [ -f "$TARBALL" ] && [ "$(sha "$TARBALL")" = "$WANT" ]; then
  echo "using the cached $NAME.tar.xz (SHA-256 checked)" >&2
else
  rm -f "$TARBALL"
  curl -fsSL --retry 4 --retry-delay 5 --connect-timeout 20 --speed-limit 20000 --speed-time 45 \
    -o "$TARBALL" "https://ziglang.org/download/$VERSION/$NAME.tar.xz"
fi
GOT="$(sha "$TARBALL")"
if [ "$GOT" != "$WANT" ]; then
  rm -f "$TARBALL"
  echo "refusing: $NAME.tar.xz has SHA-256 $GOT, not the pinned $WANT" >&2
  exit 3
fi
tar -xJf "$TARBALL" -C "$DEST"
[ -n "$CACHE" ] || rm -f "$TARBALL"
echo "ZIG=$DEST/$NAME/zig"
