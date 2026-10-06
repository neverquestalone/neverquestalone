#!/bin/bash
# Builds nqa-capture.exe, the Windows capture helper (PRD §11.3, DB11), by
# cross-compiling for x86_64 Windows with MinGW-w64. Same sources and flags three ways:
#
#   bridge/capture/windows/build.sh            zig cc (the release build; ZIG=/path/to/zig, else zig on PATH)
#   bridge/capture/windows/build.sh --docker   a Debian MinGW-w64 image, compiled with --network none (unverified)
#   bridge/capture/windows/build.sh --native   a local x86_64-w64-mingw32-gcc, or on Windows the
#                                              MinGW-w64 gcc on PATH (test.yml's windows-smoke job
#                                              compiles it this way as a cross-check)
#   bridge/capture/windows/build.sh --in-container   (what the Docker step runs)
#
# WC_BUILD_DIR=<folder> writes somewhere other than build/ (relative to this folder).
# fetch-zig.sh downloads the pinned Zig below and checks its SHA-256 (CI uses it).
#
# The release build is pinned and reproducible: Zig 0.16.0 (it bundles MinGW-w64's
# headers and CRT, so the toolchain is one download) with its tarball's published
# SHA-256 checked when you install it, e.g. from https://ziglang.org/download/index.json:
#   zig-aarch64-macos-0.16.0.tar.xz  b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489
#   zig-x86_64-macos-0.16.0.tar.xz   0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7
#   zig-x86_64-linux-0.16.0.tar.xz   70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
# The build refuses another Zig version (ZIG_ANY_VERSION=1 overrides, for a trial only),
# strips debug info (no PDB path or GUID in the exe), and builds twice in different
# folders to prove it gets the same bytes; the SHA-256 is the release's. The second build
# gets its own empty zig caches: zig caches the linked exe, so a second build that shares
# the first one's cache is a copy of it, not a build (0.1 s against 20 s from nothing).
# WC_ONE_BUILD=1 builds once, for test.yml's capture-windows job alone, which builds from
# zig's cache; its capture-windows-reproducible job, beside it, makes the proof from
# nothing, as a release does. A release never sets it.
#
# "Statically linked, without a runtime" (§11.3): nothing to install. The exe imports
# only Windows components: d3d11, dxgi, kernel32, user32 and the Universal CRT
# (api-ms-win-crt-*, part of Windows 10 and 11, the helper's only targets). The
# MinGW-gcc paths link the older msvcrt.dll instead, also part of Windows.
#
# Output: build/nqa-capture.exe and build/nqa-capture.exe.sha256. The
# build fails if the import table names a networking DLL (the helper has no
# network code). Signing happens later, in the release job, with the app's identity.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="nqa-capture-mingw:bookworm-1"
OUT="${WC_BUILD_DIR:-build}"
ZIG_VERSION="0.16.0"
SOURCES=(main.c decoder.c errlimit.c jsonl.c ppm.c winpick.c)
CFLAGS=(-std=c11 -O2 -Wall -Wextra -Werror -municode -DUNICODE -D_UNICODE)
LIBS=(-ld3d11 -ldxgi -luser32 -lkernel32)
NET_DLLS='ws2_32|wsock32|mswsock|wininet|winhttp|dnsapi|iphlpapi|urlmon|webio|httpapi|netapi32'

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# $1: the DLL names the executable imports, one per line.
check_and_sum() {
  local imports
  imports="$(echo "$1" | tr 'A-Z' 'a-z' | sort -u)"
  echo "imports: $(echo "$imports" | tr '\n' ' ')"
  if echo "$imports" | grep -Eq "^($NET_DLLS)\.dll$"; then
    echo "refusing: the helper must not import networking DLLs" >&2
    rm -f "$OUT/nqa-capture.exe"
    exit 3
  fi
  (cd "$OUT" && echo "$(sha256 nqa-capture.exe)  nqa-capture.exe" > nqa-capture.exe.sha256 && cat nqa-capture.exe.sha256)
}

# A MinGW-w64 tool: a cross compiler's carries the target's prefix; on Windows (Git Bash, MSYS2)
# the native MinGW-w64 toolchain's has none.
mingw() {
  local tool="$1"
  shift
  if command -v "x86_64-w64-mingw32-$tool" >/dev/null; then
    "x86_64-w64-mingw32-$tool" "$@"
  elif [ "$(gcc -dumpmachine 2>/dev/null | tr -d '\r')" = "x86_64-w64-mingw32" ] && command -v "$tool" >/dev/null; then
    "$tool" "$@"
  else
    echo "no MinGW-w64 $tool (x86_64-w64-mingw32-$tool, or $tool from a native MinGW-w64 gcc)" >&2
    exit 2
  fi
}

compile_mingw() {
  cd "$HERE"
  mkdir -p "$OUT"
  mingw windres -O coff -o "$OUT/nqa-capture.res.o" nqa-capture.rc
  mingw gcc "${CFLAGS[@]}" -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 \
    -o "$OUT/nqa-capture.exe" "${SOURCES[@]}" "$OUT/nqa-capture.res.o" \
    -static -static-libgcc -Wl,--dynamicbase -Wl,--nxcompat -Wl,--high-entropy-va -Wl,--no-insert-timestamp \
    "${LIBS[@]}"
  mingw strip "$OUT/nqa-capture.exe"
  rm -f "$OUT/nqa-capture.res.o"
  check_and_sum "$(mingw objdump -p "$OUT/nqa-capture.exe" | sed -n 's/^[[:space:]]*DLL Name: //p' | tr -d '\r')"
}

# $1: the output exe. zig predefines _WIN32_WINNT 0x0A00 and compiles the .rc itself.
zig_build() {
  "$ZIG" cc -target x86_64-windows-gnu "${CFLAGS[@]}" -s -o "$1" "${SOURCES[@]}" nqa-capture.rc "${LIBS[@]}"
  rm -f "${1%.exe}.pdb" "${1%.exe}.lib"
}

compile_zig() {
  ZIG="${ZIG:-zig}"
  command -v "$ZIG" >/dev/null || { echo "zig not found (set ZIG=/path/to/zig $ZIG_VERSION)" >&2; exit 2; }
  local have
  have="$("$ZIG" version)"
  if [ "$have" != "$ZIG_VERSION" ] && [ "${ZIG_ANY_VERSION:-}" != 1 ]; then
    echo "zig $have: the release build is pinned to zig $ZIG_VERSION (ZIG_ANY_VERSION=1 for a trial build)" >&2
    exit 2
  fi
  cd "$HERE"
  mkdir -p "$OUT"
  zig_build "$OUT/nqa-capture.exe"
  if [ "${WC_ONE_BUILD:-}" = 1 ]; then
    echo "one build (WC_ONE_BUILD=1): not checked for reproducibility here; test.yml's capture-windows-reproducible and a release check it"
  else
    # Reproducible: a second build in another folder, from its own empty zig caches, must give the same bytes.
    local again
    again="$(mktemp -d)"
    mkdir "$again/out" "$again/global-cache" "$again/local-cache"
    ZIG_GLOBAL_CACHE_DIR="$again/global-cache" ZIG_LOCAL_CACHE_DIR="$again/local-cache" zig_build "$again/out/nqa-capture.exe"
    if [ "$(sha256 "$OUT/nqa-capture.exe")" != "$(sha256 "$again/out/nqa-capture.exe")" ]; then
      rm -rf "$again"
      echo "refusing: two builds of the same sources differ (the build is not reproducible)" >&2
      rm -f "$OUT/nqa-capture.exe"
      exit 4
    fi
    rm -rf "$again"
    echo "reproducible: a second build in another folder, from its own empty zig cache, is identical"
  fi
  check_and_sum "$(strings -a "$OUT/nqa-capture.exe" | grep -iE '^[a-z0-9_.-]+\.dll$')"
}

case "${1:-}" in
  ""|--zig)
    compile_zig
    ;;
  --in-container|--native)
    compile_mingw
    ;;
  --docker)
    command -v docker >/dev/null || { echo "docker not found; use the default zig build" >&2; exit 2; }
    docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
    docker run --rm --network none --user "$(id -u):$(id -g)" -v "$HERE":/src -w /src "$IMAGE" ./build.sh --in-container
    echo "built: $HERE/$OUT/nqa-capture.exe"
    ;;
  *)
    echo "usage: $0 [--zig | --docker | --native]" >&2
    exit 2
    ;;
esac
