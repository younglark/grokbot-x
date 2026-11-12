# Official Grok Bot 1.0.1 on Windows and macOS

Inspected on 2026-11-12 from the public update feed. Packages were downloaded to this machine and unpacked for static analysis only — they were not installed or launched.

## Update feed

`https://api2.cursor.sh/updates/api/download/stable/<platform>/sand` returns 1.0.1 (`commitSha` 7eb488cd12ea2e65065a6b227f3ab49160b618bd) for:

| platform | artifact |
|---|---|
| linux-x64 | AppImage, `grok-bot_1.0.1_amd64.deb`, rpm |
| darwin-arm64 / darwin-x64 / darwin-universal | `Grok_Bot_1.0.1.dmg` (x64 file is `Grok_Bot_1.0.1_x64.dmg`) |
| win32-x64 / win32-arm64 / win32-x64-user | `Grok_Bot_1.0.1_Setup.exe` (NSIS 3 Unicode; payload `app-64.7z`) |
| win32-x64-system | HTTP 400 (no separate machine-wide feed) |

## Electron fuses (identical on Linux, Windows, macOS)

Read with `@electron/fuses` against the official binaries:

| Fuse | Value |
|---|---|
| RunAsNode | Disabled |
| EnableCookieEncryption | Enabled |
| EnableNodeOptionsEnvironmentVariable | Disabled |
| EnableNodeCliInspectArguments | **Disabled** |
| EnableEmbeddedAsarIntegrityValidation | Enabled |
| OnlyLoadAppFromAsar | Enabled |
| LoadBrowserProcessSpecificV8Snapshot | Disabled |
| GrantFileProtocolExtraPrivileges | Enabled |
| WasmTrapHandlers | Enabled |

`EnableNodeCliInspectArguments` being disabled blocks Node `--inspect`, **not** Chromium `--remote-debugging-port`. On Linux 1.0.1, `--remote-debugging-port` + `--remote-debugging-address=127.0.0.1` is confirmed working. The same Chromium switch should work on Windows and macOS (same Electron fuses, same main-process argument handling); **this has not been launched on those operating systems**.

## Default paths (from the packages, not from a live install)

| | Windows (NSIS) | macOS | Linux (.deb) |
|---|---|---|---|
| Executable | `Grok Bot.exe` | `Grok Bot.app/Contents/MacOS/Grok Bot` | `/opt/Grok Bot/grok-bot` (`/usr/bin/grok-bot` symlink) |
| Typical install | `%LOCALAPPDATA%\Programs\Grok Bot\` (NSIS strings include `\Programs`, `\Grok Bot`, `\Grok Bot.exe`). A machine-wide `C:\Program Files\Grok Bot\` is also searched. | `/Applications/Grok Bot.app` or `~/Applications/Grok Bot.app` | `/opt/Grok Bot/` |
| Bundle id / AppUserModelID | `com.anysphere.sand` (`UninstAppUserModelId` in the uninstaller) | `CFBundleIdentifier` = `com.anysphere.sand` | n/a (desktop file `grok-bot.desktop`) |
| URL schemes | (not re-read from the exe) | `grokbot`, `sand` | — |
| Minimum OS | (not declared in the unpacked payload) | `LSMinimumSystemVersion` 12.0 | — |

Electron's default `userData` directory, if unchanged, is typically `%APPDATA%\Grok Bot` on Windows and `~/Library/Application Support/Grok Bot` on macOS (on Linux it is `~/.config/Grok Bot`). **Not verified by launching the official app.**

## `SAND_USER_DATA_DIR`

Present in `main.cjs` on Windows, macOS, and Linux: a non-empty absolute value becomes the isolated user-data directory (and `--user-data-dir` is still passed by grokbot-x). Confirmed at runtime only on Linux.

## Injection surface

`app.asar` hashes differ across platforms (native `.node` addons, and some hashed renderer / main-process file names). The selectors grokbot-x relies on are the same in all three asars:

- `sand-media-viewer__download`, `img.sand-media-viewer__image`, icon `arrow-bracket-to-down`
- `sand-media:` URL scheme (`protocol!==\`sand-media:\``)
- renderer CSP `frame-src sand-html-preview: sand-canvas: sand-mcp-app: sand-visualization:`
- `requestSingleInstanceLock()` in `main-core.cjs`

Official upgrades can still rename these classes; the button is hidden when the download control is missing.

## Single-instance lock

Packaged builds call `requestSingleInstanceLock()` and quit if they are not the primary instance. Starting a second copy against the same user-data directory will not keep a second DevTools port open. grokbot-x therefore attaches to the already-running process when it already has a loopback debug port, and otherwise asks before restarting it.

## 交互预览验收如何取附件

用户已允许 grokbot-x 经官方媒体协议读取消息里的验收 zip，以便**无弹窗打开**。实现上是在官方渲染进程里对 `sand-media://attachment/…` 做分块 Range 请求（必要时带当前账号的媒体令牌），由 grokbot-x 主进程拼接；不改 `isAnysphereUser`，也不把令牌写进日志。

官方升级可能改变协议、令牌或页面结构。失败时 `features/preview` 会退回到 `window.desktop.downloadAttachment`（弹一次系统保存框），再不行就让用户自己选文件。本节结论来自对 1.0.1 安装包的静态分析，**没有在真实登录的客户端上验证过这条路径**。
