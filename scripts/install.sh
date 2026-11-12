#!/usr/bin/env bash
# grokbot-x one-click installer for Linux and macOS.
# Official usage:
#   curl -fsSL https://github.com/younglark/grokbot-x/releases/latest/download/install.sh | bash
#
# Installs into the current user's home directory. Does not use sudo, does not
# install the official Grok Bot client, and does not enable login autostart.
set -euo pipefail

REPO="younglark/grokbot-x"
DEFAULT_BASE="https://github.com/${REPO}/releases/latest/download"
BASE="${GROKBOT_X_RELEASE_BASE:-$DEFAULT_BASE}"
HOME_DIR="${GROKBOT_X_HOME:-${HOME:-}}"
ICON_URL="${GROKBOT_X_ICON_URL:-https://raw.githubusercontent.com/${REPO}/main/assets/grokbot-x-64.png}"

die() { printf 'grokbot-x 安装失败：%s\n' "$*" >&2; exit 1; }
info() { printf 'grokbot-x：%s\n' "$*"; }

[ -n "$HOME_DIR" ] || die "无法确定家目录（HOME 未设置）"

uid="$(id -u)"
[ "$uid" -ne 0 ] || die "请不要用 root 运行。本脚本默认安装到当前用户目录，不需要 sudo。"

command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v openssl >/dev/null 2>&1 || die "需要 openssl（用来校验下载文件）"

os="$(uname -s)"
machine="$(uname -m)"

case "$os" in
  Linux)
    plat=linux
    case "$machine" in
      x86_64|amd64) arch=x64 ;;
      *) die "目前只提供 Linux x64 安装包（当前架构：$machine）" ;;
    esac
    meta_name="latest-linux.yml"
    # electron-builder expands Linux ${arch} to x86_64 (AppImage) / amd64 (deb),
    # not "x64". Prefer the AppImage so in-app updates work; accept x64 as fallback.
    want="linux-x86_64.AppImage"
    want_fallback="linux-${arch}.AppImage"
    ;;
  Darwin)
    plat=mac
    # Prefer the native arm64 build even if this shell is running under Rosetta.
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
      arch=arm64
    else
      case "$machine" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64) arch=x64 ;;
        *) die "无法识别的 macOS 架构：$machine" ;;
      esac
    fi
    meta_name="latest-mac.yml"
    # zip is easier to unpack unattended; dmg is the fallback.
    want="mac-${arch}.zip"
    want_fallback="mac-${arch}.dmg"
    ;;
  *)
    die "不支持的系统：$os。Windows 请用：irm https://github.com/${REPO}/releases/latest/download/install.ps1 | iex"
    ;;
esac

# Parse electron-builder latest-*.yml (version / files[].url / files[].sha512).
# Prints three lines: version, url (filename), sha512 (base64). awk-only so
# macOS (bash 3.2, no extra Python/YAML deps) can run this script.
parse_latest_yml() {
  # $1 = path to yml, $2 = filename substring that must match
  awk -v want="$2" '
    BEGIN { found = 0; url = ""; sha = ""; ver = "" }
    /^version:/ {
      ver = $2
      gsub(/["\047]/, "", ver)
      next
    }
    $1 == "-" && $2 == "url:" {
      url = $3
      gsub(/["\047]/, "", url)
      sha = ""
      next
    }
    $1 == "url:" {
      url = $2
      gsub(/["\047]/, "", url)
      sha = ""
      next
    }
    $1 == "sha512:" && url != "" && sha == "" {
      sha = $2
      gsub(/["\047]/, "", sha)
      if (index(url, want) && !found) {
        print ver
        print url
        print sha
        found = 1
      }
    }
    END { if (!found) exit 2 }
  ' "$1"
}

sha512_base64() {
  # electron-builder writes sha512 as base64, not hex.
  openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n\r '
}

verify_sha512() {
  file="$1"
  expected="$2"
  actual="$(sha512_base64 "$file")"
  if [ "$actual" != "$expected" ]; then
    printf '校验失败：%s\n  期望 sha512: %s\n  实际 sha512: %s\n' "$file" "$expected" "$actual" >&2
    return 1
  fi
}

download() {
  url="$1"
  dest="$2"
  command -v curl >/dev/null 2>&1 || die "需要 curl"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 600 \
    -A "grokbot-x-installer" -o "$dest" "$url" \
    || die "下载失败：$url"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/grokbot-x-install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

info "正在获取最新版本信息（$meta_name）…"
download "${BASE}/${meta_name}" "${TMP}/latest.yml"

if ! META="$(parse_latest_yml "${TMP}/latest.yml" "$want")"; then
  if [ -n "${want_fallback:-}" ]; then
    info "未找到 ${want}，尝试 ${want_fallback}…"
    want="$want_fallback"
    META="$(parse_latest_yml "${TMP}/latest.yml" "$want")" \
      || die "在 ${meta_name} 里找不到匹配 ${want} 的资源"
  else
    die "在 ${meta_name} 里找不到匹配 ${want} 的资源。Release 是否已发布？"
  fi
fi

VERSION="$(printf '%s\n' "$META" | sed -n '1p')"
FILENAME="$(printf '%s\n' "$META" | sed -n '2p')"
SHA="$(printf '%s\n' "$META" | sed -n '3p')"
if [ -z "$VERSION" ] || [ -z "$FILENAME" ] || [ -z "$SHA" ]; then
  die "解析 ${meta_name} 失败"
fi

info "最新版本：${VERSION}"
info "正在下载 ${FILENAME}…"
download "${BASE}/${FILENAME}" "${TMP}/${FILENAME}"
info "正在校验 sha512…"
verify_sha512 "${TMP}/${FILENAME}" "$SHA" || die "校验和不匹配，已中止安装"

install_linux() {
  dest_dir="${HOME_DIR}/.local/opt/grokbot-x"
  dest="${dest_dir}/grokbot-x.AppImage"
  apps="${HOME_DIR}/.local/share/applications"
  icons="${HOME_DIR}/.local/share/icons/hicolor/64x64/apps"
  mkdir -p "$dest_dir" "$apps"
  chmod +x "${TMP}/${FILENAME}"
  # Replace atomically so a running previous AppImage is less likely to break.
  cp "${TMP}/${FILENAME}" "${dest}.new"
  chmod +x "${dest}.new"
  mv -f "${dest}.new" "$dest"
  chmod +x "$dest"

  icon_line=""
  if [ "${GROKBOT_X_SKIP_ICON:-}" != "1" ]; then
    mkdir -p "$icons"
    if curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 \
        -A "grokbot-x-installer" -o "${icons}/grokbot-x.png" "$ICON_URL"; then
      icon_line="Icon=grokbot-x"
    else
      info "图标下载失败，桌面项仍可使用。"
    fi
  fi

  desktop="${apps}/grokbot-x.desktop"
  {
    printf '%s\n' "[Desktop Entry]"
    printf '%s\n' "Name=Grok Bot X"
    printf '%s\n' "Comment=Start Grok Bot with grokbot-x add-ons"
    printf '%s\n' "Exec=${dest}"
    [ -n "$icon_line" ] && printf '%s\n' "$icon_line"
    printf '%s\n' "Type=Application"
    printf '%s\n' "Categories=Utility;"
    printf '%s\n' "Terminal=false"
    printf '%s\n' "StartupNotify=false"
  } > "$desktop"
  chmod 644 "$desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME_DIR}/.local/share/applications" >/dev/null 2>&1 || true
  fi
  info "已安装 AppImage 到：${dest}"
  info "已写入用户级桌面项：${desktop}"
  info "未开启登录自启，也未安装官方 Grok Bot。"
}

install_mac() {
  dest_root="${HOME_DIR}/Applications"
  dest="${dest_root}/Grok Bot X.app"
  mkdir -p "$dest_root"
  extract="${TMP}/extract"
  mkdir -p "$extract"

  case "$FILENAME" in
    *.zip)
      command -v unzip >/dev/null 2>&1 || die "需要 unzip"
      unzip -q "${TMP}/${FILENAME}" -d "$extract"
      ;;
    *.dmg)
      command -v hdiutil >/dev/null 2>&1 || die "需要 hdiutil"
      mnt="${TMP}/mnt"
      mkdir -p "$mnt"
      hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "${TMP}/${FILENAME}" >/dev/null \
        || die "无法挂载 dmg"
      # Copy then detach even if the copy fails.
      if ! cp -R "$mnt"/*.app "$extract/" 2>/dev/null; then
        hdiutil detach "$mnt" >/dev/null 2>&1 || true
        die "dmg 里没有找到 .app"
      fi
      hdiutil detach "$mnt" >/dev/null || true
      ;;
    *)
      die "未知的 macOS 安装包格式：$FILENAME"
      ;;
  esac

  app="$(find "$extract" -name "*.app" -type d -prune | head -n 1 || true)"
  [ -n "$app" ] || die "安装包里没有找到 .app"
  rm -rf "$dest"
  mv "$app" "$dest"
  info "已安装到：${dest}"
  info "本安装包未签名。首次打开请在 Finder 里右键点「Grok Bot X」→「打开」。"
  info "未开启登录自启，也未安装官方 Grok Bot。"
}

case "$plat" in
  linux) install_linux ;;
  mac) install_mac ;;
esac

info "安装完成（版本 ${VERSION}）。"
