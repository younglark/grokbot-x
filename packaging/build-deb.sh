#!/usr/bin/env bash
# Build release/grokbot-x_<version>_amd64.deb: bundled Node runtime + ws + kernel + features.
# Usage: packaging/build-deb.sh   (downloads are cached in .cache/ and SHA-256 verified)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PKG=grokbot-x
VERSION="${GROKBOT_X_VERSION:-0.1.0}"
ARCH=amd64
NODE_VERSION=22.23.5
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
WS_VERSION=8.22.2
WS_TARBALL="ws-${WS_VERSION}.tgz"
WS_SHA256=de7148fed079cf115faacda8118276839dc9ab377d6b9075cea3424fa1d758f2

for c in curl tar xz dpkg-deb sha256sum; do command -v "$c" >/dev/null || { echo "missing build tool: $c" >&2; exit 2; }; done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version $VERSION" >&2; exit 2; }

CACHE="$ROOT/.cache"; mkdir -p "$CACHE" release
fetch() { # fetch <url> <file> <sha256>
  local url="$1" out="$CACHE/$2" sum="$3"
  if [[ ! -f "$out" ]] || ! echo "$sum  $out" | sha256sum -c --status; then
    echo "downloading $url"
    curl -fL --retry 3 -o "$out.part" "$url"
    mv "$out.part" "$out"
  fi
  echo "$sum  $out" | sha256sum -c --quiet || { echo "SHA-256 mismatch for $2" >&2; rm -f "$out"; exit 3; }
}
fetch "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" "$NODE_TARBALL" "$NODE_SHA256"
fetch "https://registry.npmjs.org/ws/-/${WS_TARBALL}" "$WS_TARBALL" "$WS_SHA256"

for f in core/daemon.mjs core/cdp.mjs core/log.mjs core/net.mjs core/page-runtime.js config/default.json \
         features/edithere/feature.mjs features/edithere/inject.js features/edithere/vendor/EditHere.html \
         features/edithere/vendor/LICENSE features/edithere/vendor/NOTICE bin/grokbot-x bin/grokbot-x-stop \
         packaging/grokbot-x.desktop README.md LICENSE; do
  [[ -f "$f" ]] || { echo "missing source file: $f" >&2; exit 2; }
done

WORK="$(mktemp -d)"; trap 'rm -rf -- "$WORK"' EXIT
STAGE="$WORK/root"; OPT="$STAGE/opt/$PKG"
mkdir -p "$OPT/runtime/node" "$OPT/node_modules/ws" "$STAGE/DEBIAN" "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" "$STAGE/usr/share/doc/$PKG"

# Node runtime: only the binary plus its license (npm/corepack are not needed).
tar -xJf "$CACHE/$NODE_TARBALL" -C "$WORK"
NODE_SRC="$WORK/node-v${NODE_VERSION}-linux-x64"
mkdir -p "$OPT/runtime/node/bin"
install -m 0755 "$NODE_SRC/bin/node" "$OPT/runtime/node/bin/node"
install -m 0644 "$NODE_SRC/LICENSE" "$OPT/runtime/node/LICENSE"
# ws: runtime files only
tar -xzf "$CACHE/$WS_TARBALL" -C "$WORK"
cp -r "$WORK/package/lib" "$WORK/package/index.js" "$WORK/package/wrapper.mjs" "$WORK/package/package.json" \
  "$WORK/package/LICENSE" "$OPT/node_modules/ws/"

# App files (explicit allow-list: no logs, profiles, images, or caches)
cp -r core config bin "$OPT/"
mkdir -p "$OPT/features/edithere/vendor"
install -m 0644 features/edithere/feature.mjs features/edithere/inject.js "$OPT/features/edithere/"
install -m 0644 features/edithere/vendor/EditHere.html features/edithere/vendor/LICENSE \
  features/edithere/vendor/NOTICE features/edithere/vendor/SOURCE.txt "$OPT/features/edithere/vendor/"
install -m 0644 README.md LICENSE "$OPT/"
printf '%s\n' "$VERSION" > "$OPT/VERSION"
chmod 0755 "$OPT/bin/"*
ln -s "/opt/$PKG/bin/grokbot-x" "$STAGE/usr/bin/grokbot-x"
ln -s "/opt/$PKG/bin/grokbot-x-stop" "$STAGE/usr/bin/grokbot-x-stop"
install -m 0644 packaging/grokbot-x.desktop "$STAGE/usr/share/applications/grokbot-x.desktop"
for s in 48 64 128 256 512; do
  install -D -m 0644 "assets/grokbot-x-$s.png" "$STAGE/usr/share/icons/hicolor/${s}x${s}/apps/grokbot-x.png"
done

cat > "$STAGE/usr/share/doc/$PKG/copyright" <<COPY
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: grokbot-x
Comment: grokbot-x is an unofficial add-on launcher. It does not modify the official
 Grok Bot client. Grok Bot is a product of its respective owner and is not included.

Files: /opt/grokbot-x/core/* /opt/grokbot-x/bin/* /opt/grokbot-x/config/*
 /opt/grokbot-x/features/edithere/feature.mjs /opt/grokbot-x/features/edithere/inject.js
Copyright: 2026 grokbot-x authors
License: MIT
 See /opt/grokbot-x/LICENSE.

Files: /opt/grokbot-x/features/edithere/vendor/*
Copyright: 2026 Inginnng (https://github.com/Inginnng/EditHere)
License: PolyForm-Noncommercial-1.0.0
 Required Notice: Copyright 2026 Inginnng (https://github.com/Inginnng/EditHere)
 .
 NONCOMMERCIAL USE ONLY. EditHere is source-available, not open source. Free use is
 limited to noncommercial purposes (personal, research, education, etc.). Any
 commercial use requires a separate written license from the author
 (inginnng@163.com). The EditHere name and logo are not licensed.
 Full text: /opt/grokbot-x/features/edithere/vendor/LICENSE and NOTICE.
 仅限非商业使用；商业用途须取得 EditHere 作者书面授权。

Files: /opt/grokbot-x/runtime/node/*
Copyright: Node.js contributors
License: MIT and others
 See /opt/grokbot-x/runtime/node/LICENSE.

Files: /opt/grokbot-x/node_modules/ws/*
Copyright: Einar Otto Stangvik and contributors
License: MIT
 See /opt/grokbot-x/node_modules/ws/LICENSE.
COPY

SIZE_KB="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"
cat > "$STAGE/DEBIAN/control" <<CTRL
Package: $PKG
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Maintainer: grokbot-x <grokbot-x@localhost>
Installed-Size: $SIZE_KB
Depends: bash, procps, coreutils
Recommends: google-chrome-stable | chromium | chromium-browser, zenity
Description: Unofficial add-on launcher for the Grok Bot desktop client
 Starts the official Grok Bot with a DevTools port bound to 127.0.0.1 and runs a
 user-level daemon that injects optional features. The official client is not
 modified. First feature: an "edit" button in the image preview that opens the
 image in EditHere (web build, PolyForm Noncommercial 1.0.0, NONCOMMERCIAL USE
 ONLY) in a separate Chrome/Chromium window.
 Security: while running, any local process can control Grok Bot through the
 DevTools port.
CTRL
cat > "$STAGE/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
exit 0
POST
cat > "$STAGE/DEBIAN/postrm" <<'POST'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
exit 0
POST
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/postrm"

# Normalise permissions and ownership
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE/opt" -type f ! -path '*/bin/*' -exec chmod 0644 {} +
chmod 0755 "$OPT/runtime/node/bin/node" "$OPT/bin/"*

# Sanity: bundled node runs and the kernel parses
"$OPT/runtime/node/bin/node" --version >/dev/null
"$OPT/runtime/node/bin/node" --check "$OPT/core/daemon.mjs"
"$OPT/runtime/node/bin/node" --check "$OPT/features/edithere/feature.mjs"

OUT="release/${PKG}_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$OUT" >/dev/null
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
sha256sum "$OUT" | tee "$OUT.sha256"
