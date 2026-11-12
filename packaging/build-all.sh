#!/usr/bin/env bash
# Build grokbot-x with electron-builder for the current OS, and attempt
# cross-builds when the tools are present (Windows nsis on Linux needs Wine).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v npm >/dev/null || { echo 'npm is required' >&2; exit 2; }
if [[ ! -d node_modules/electron ]]; then npm ci || npm install; fi
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run build:editor
HOST="$(uname -s)"
case "$HOST" in
  Linux)
    npx electron-builder --linux deb AppImage
    if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
      echo 'Wine found; attempting Windows nsis build'
      npx electron-builder --win nsis || echo 'Windows nsis build failed (will be produced on the Windows CI runner)'
    else
      echo 'Wine not found; skipping Windows nsis on Linux (CI will build it)'
    fi
    echo 'macOS packages must be built on a macOS runner (electron-builder cannot cross-compile them here).'
    ;;
  Darwin)
    npx electron-builder --mac dmg zip
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    npx electron-builder --win nsis
    ;;
  *) echo "unsupported host: $HOST" >&2; exit 2 ;;
esac
echo 'artifacts:'
find release -maxdepth 2 -type f \( -name '*.deb' -o -name '*.AppImage' -o -name '*.exe' -o -name '*.dmg' -o -name '*.zip' -o -name '*.yml' \) -printf '%s %p\n' 2>/dev/null || ls -la release
