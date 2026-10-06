# Toolchain image for nqa-capture.exe (PRD §11.3, DB11): MinGW-w64 for
# x86_64 Windows on Debian. `build.sh --docker` builds this image, then compiles
# inside it with the network off. Only the toolchain lives here; the sources are
# mounted. An alternative, not yet run: the release build is build.sh's pinned zig.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
