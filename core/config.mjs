// Shared configuration loading for the launcher and the daemon.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`grokbot-x: ignoring unreadable config ${file}: ${e.message}\n`);
    return null;
  }
}

export function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

export function appVersion() {
  try { return fs.readFileSync(path.join(APP_DIR, 'VERSION'), 'utf8').trim(); } catch { /* dev tree */ }
  return readJson(path.join(APP_DIR, 'package.json'))?.version || '0.0.0-dev';
}

/** default.json <- user config.json <- env overrides. */
export function loadConfig(plat, explicitFile) {
  const env = plat.env;
  const userFile = explicitFile || env.GROKBOT_X_CONFIG || path.join(plat.configDir(), 'config.json');
  let cfg = readJson(path.join(APP_DIR, 'config', 'default.json')) || {};
  cfg = deepMerge(cfg, readJson(userFile) || {});
  cfg.launcher = cfg.launcher || {};
  if (env.GROK_BOT_BIN) cfg.launcher.grokBotBin = env.GROK_BOT_BIN;
  if (env.GROK_BOT_CDP_PORT) cfg.cdpPort = Number(env.GROK_BOT_CDP_PORT);
  if (env.GROK_BOT_USER_DATA_DIR !== undefined) cfg.launcher.userDataDir = env.GROK_BOT_USER_DATA_DIR;
  if (env.GROK_BOT_EXTRA_ARGS) cfg.launcher.extraArgs = env.GROK_BOT_EXTRA_ARGS.split(/\s+/).filter(Boolean);
  for (const name of String(env.GROKBOT_X_DISABLE || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    cfg.features = cfg.features || {};
    cfg.features[name] = { ...(cfg.features[name] || {}), enabled: false };
  }
  return { cfg, userFile };
}

/** Merge a patch into the user config file (never writes secrets). */
export function saveUserConfig(plat, patch, explicitFile) {
  const file = explicitFile || plat.env.GROKBOT_X_CONFIG || path.join(plat.configDir(), 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const cur = readJson(file) || {};
  const next = deepMerge(cur, patch);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return { file, cfg: next };
}
