// Put saved files on the system clipboard as a FILE LIST (not text + bitmap),
// so pasting into a chat composer yields one attachment per file.
//
// Mirrors the upstream EditHere desktop (Qt) behaviour: QMimeData::setUrls()
// with the feedback JSON first, then its companion images.
//
// Per platform:
//   linux  -> clipboard.writeBuffer('text/uri-list', ...) (RFC 2483, CRLF).
//             Electron clears the clipboard on every write call, so only ONE
//             raw format can be offered; text/uri-list is what Chromium and
//             GTK/Qt apps read for pasted files.
//   darwin -> osascript (JXA) NSPasteboard writeObjects([NSURL…]), i.e. one
//             public.file-url item per file, like Qt. Fallback: writeBuffer
//             with an NSFilenamesPboardType plist.
//   win32  -> Windows PowerShell 5.1 Set-Clipboard -LiteralPath (CF_HDROP).
// Any failure is reported so the caller can fall back to text + image.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function fileUri(p) {
  return pathToFileURL(p).href;
}

/** text/uri-list body: one file:// URI per line, CRLF separated (RFC 2483). */
export function uriList(paths) {
  return paths.map((p) => `${fileUri(p)}\r\n`).join('');
}

/** x-special/gnome-copied-files body (Nautilus); not offered alone, see header. */
export function gnomeCopiedFiles(paths) {
  return ['copy', ...paths.map(fileUri)].join('\n');
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Legacy NSFilenamesPboardType property list (array of POSIX paths). */
export function filenamesPlist(paths) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><array>'
    + paths.map((p) => `<string>${xmlEscape(p)}</string>`).join('')
    + '</array></plist>\n';
}

// JXA script; paths arrive as argv so nothing is interpolated into code.
export const MAC_JXA = [
  'ObjC.import("AppKit");',
  'function run(argv){',
  '  var pb=$.NSPasteboard.generalPasteboard; pb.clearContents;',
  '  var urls=$.NSMutableArray.array;',
  '  for (var i=0;i<argv.length;i++) urls.addObject($.NSURL.fileURLWithPath(argv[i]));',
  '  if(!pb.writeObjects(urls)) throw new Error("writeObjects failed");',
  '  return String(pb.pasteboardItems.count);',
  '}',
].join('\n');

// Paths arrive via an environment variable (newline separated), never in code.
export const WIN_PS = "$ErrorActionPreference='Stop'; "
  + "$p = $env:GX_CLIP_FILES -split \"`n\" | Where-Object { $_ }; "
  + 'Set-Clipboard -LiteralPath $p';

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: (stderr || err.message || '').toString().trim() } : { ok: true, stdout: String(stdout).trim() });
    });
  });
}

/**
 * @param {string[]} paths absolute paths, JSON first
 * @param {{clipboard: import('electron').Clipboard, platform?: string, exec?: Function}} deps
 */
export async function writeFileList(paths, { clipboard, platform = process.platform, exec = run } = {}) {
  const list = (paths || []).filter((p) => typeof p === 'string' && path.isAbsolute(p));
  if (!list.length) return { ok: false, error: 'no files' };
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    clipboard.writeBuffer('text/uri-list', Buffer.from(uriList(list), 'utf8'));
    return { ok: true, method: 'text/uri-list', count: list.length };
  }
  if (platform === 'darwin') {
    const r = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_JXA, ...list]);
    if (r.ok) return { ok: true, method: 'NSPasteboard.writeObjects', count: list.length };
    try {
      clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(filenamesPlist(list), 'utf8'));
      return { ok: true, method: 'NSFilenamesPboardType', count: list.length, note: r.error };
    } catch (e) {
      return { ok: false, error: `${r.error}; ${e.message}` };
    }
  }
  if (platform === 'win32') {
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', WIN_PS], {
      env: { ...process.env, GX_CLIP_FILES: list.join('\n') },
    });
    return r.ok ? { ok: true, method: 'Set-Clipboard -LiteralPath', count: list.length } : { ok: false, error: r.error };
  }
  return { ok: false, error: `unsupported platform ${platform}` };
}

/**
 * Saved paths for the requested files, restricted to paths this process just
 * wrote (never trusts renderer-supplied paths). JSON first, like upstream.
 */
export function savedPathsFor(files, saved = [], exists = fs.existsSync) {
  const byName = new Map(saved.map((p) => [path.basename(p), p]));
  const picked = [];
  for (const f of files || []) {
    const p = byName.get(f && f.name);
    if (p && exists(p) && !picked.includes(p)) picked.push(p);
  }
  const rank = (p) => (/\.json$/i.test(p) ? 0 : 1);
  return picked.sort((a, b) => rank(a) - rank(b));
}
