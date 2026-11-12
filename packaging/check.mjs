#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(d) {
  for (const n of fs.readdirSync(d)) {
    if (n === 'node_modules' || n === 'release' || n === '.cache' || n === '.git') continue;
    const p = path.join(d, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(n) && !p.includes('vendor/')) files.push(p);
  }
}
walk(root);
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; process.stderr.write(`FAIL ${path.relative(root, f)}\n${r.stderr}`); }
}
if (failed) { process.stderr.write(`${failed} file(s) failed node --check\n`); process.exit(1); }
process.stdout.write(`ok: ${files.length} files passed node --check\n`);
