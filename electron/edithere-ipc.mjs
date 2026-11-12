// Validation for editor IPC payloads. Pure Node, no Electron imports,
// so tests can exercise the same checks the main process uses.
export const MAX_FILE_BYTES = 80 * 1024 * 1024;
export const MAX_FILES = 32;
export const MAX_TEXT_CHARS = 20 * 1024 * 1024;
export const KINDS = new Set(['feedback', 'project', 'annotated', 'file', 'self-test']);
export const ALLOWED_MIME = /^(application\/(json|zip|octet-stream)|image\/(png|jpeg|jpg|webp|gif|bmp)|text\/plain)$/i;
export const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/]+={0,2})$/;

export function sanitizeFileName(name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop();
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff()[\]-]+/g, '_').replace(/^\.+/, '').slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !value.length) return { ok: false, error: `missing data for ${label}` };
  if (value.length > MAX_FILE_BYTES * 2) return { ok: false, error: `payload too large: ${label}` };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return { ok: false, error: `bad base64: ${label}` };
  }
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length) return { ok: false, error: `empty file: ${label}` };
  if (buffer.length > MAX_FILE_BYTES) return { ok: false, error: `file too large: ${label}` };
  return { ok: true, buffer };
}

export function validateFilesPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }
  const kind = String(payload.kind || 'file');
  if (!KINDS.has(kind)) return { ok: false, error: `invalid kind: ${kind}` };
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    return { ok: false, error: 'files required' };
  }
  if (payload.files.length > MAX_FILES) return { ok: false, error: 'too many files' };
  const files = [];
  let total = 0;
  const seen = new Set();
  for (const entry of payload.files) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'invalid file entry' };
    const name = sanitizeFileName(entry.name);
    if (!name) return { ok: false, error: 'invalid file name' };
    if (seen.has(name)) return { ok: false, error: `duplicate file name: ${name}` };
    seen.add(name);
    const mime = String(entry.mime || 'application/octet-stream');
    if (!ALLOWED_MIME.test(mime)) return { ok: false, error: `disallowed mime: ${mime}` };
    const decoded = decodeBase64(entry.base64, name);
    if (!decoded.ok) return decoded;
    total += decoded.buffer.length;
    if (total > MAX_FILE_BYTES) return { ok: false, error: 'payload too large' };
    files.push({ name, mime, buffer: decoded.buffer });
  }
  return {
    ok: true,
    kind,
    files,
    reveal: payload.reveal !== false,
    pickLocation: payload.pickLocation === true,
  };
}

export function validateCopyText(payload) {
  const text = typeof payload === 'string' ? payload : payload?.text;
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
  if (text.length > MAX_TEXT_CHARS) return { ok: false, error: 'text too large' };
  return { ok: true, text };
}

export function validateCopyFiles(payload) {
  const result = validateFilesPayload({ ...payload, kind: payload?.kind || 'feedback' });
  if (!result.ok) return result;
  return { ok: true, files: result.files };
}

export function validateImagePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'image payload must be an object' };
  }
  const name = sanitizeFileName(payload.name || 'image.png') || 'image.png';
  const match = DATA_URL_RE.exec(String(payload.dataUrl || ''));
  if (!match) return { ok: false, error: 'dataUrl must be a base64 image/* URL' };
  const decoded = decodeBase64(match[2], name);
  if (!decoded.ok) return decoded;
  const width = Number(payload.width) || 0;
  const height = Number(payload.height) || 0;
  return {
    ok: true,
    name,
    mime: match[1],
    dataUrl: `data:${match[1]};base64,${match[2]}`,
    buffer: decoded.buffer,
    width: width > 0 && width < 100000 ? width : 0,
    height: height > 0 && height < 100000 ? height : 0,
    exportDir: typeof payload.exportDir === 'string' ? payload.exportDir.slice(0, 1000) : '',
  };
}

export function exportStamp(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

export function imageInfo(buf) {
  if (!buf || buf.length < 8) return { fmt: 'unknown', mime: '', w: 0, h: 0 };
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { fmt: 'png', mime: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length && buf[i] === 0xff) {
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
        return { fmt: 'jpeg', mime: 'image/jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { fmt: 'jpeg', mime: 'image/jpeg', w: 0, h: 0 };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const k = buf.toString('ascii', 12, 16);
    if (k === 'VP8X') return { fmt: 'webp', mime: 'image/webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (k === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { fmt: 'webp', mime: 'image/webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    return { fmt: 'webp', mime: 'image/webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { fmt: 'gif', mime: 'image/gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return { fmt: 'bmp', mime: 'image/bmp', w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  return { fmt: 'unknown', mime: '', w: 0, h: 0 };
}
