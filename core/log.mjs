// Timestamped logger (Asia/Shanghai). Never pass secrets or page content here.
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export function createLogger(scope) {
  const write = (level, args) => {
    const line = `[${fmt.format(new Date())} CST] ${level} [${scope}] ` +
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Strip query/fragment and inline data so URLs are safe to log. */
export function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return '(empty)';
  if (raw.startsWith('data:')) return `data:${(raw.match(/^data:([^;,]*)/) || [])[1] || '?'};(${raw.length} chars)`;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0].slice(0, 160);
  }
}
