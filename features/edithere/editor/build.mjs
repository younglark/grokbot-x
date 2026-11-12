#!/usr/bin/env node
// grokbot-x editor builder. Logic follows EditHere web/build.cjs (inline CSS/JS
// and UI icons into a single HTML file) but uses a fixed version string and
// does not emit DSH/MCP variants or embed the EditHere wordmark/logo.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const EDITOR_VERSION = '0.13.0-grokbot-x.1';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const iconDirectory = path.join(here, 'assets', 'ui-icons');
const appRoot = path.resolve(here, '../../..');
const outDir = path.join(here, '..', 'build');
const outFile = path.join(outDir, 'editor.html');

const iconManifest = JSON.parse(fs.readFileSync(path.join(iconDirectory, 'manifest.json'), 'utf8'));
if (
  iconManifest.schemaVersion !== 1 ||
  !iconManifest.icons?.length ||
  iconManifest.style?.viewBox !== '0 0 24 24' ||
  iconManifest.style?.strokeWidth !== 2 ||
  iconManifest.style?.linecap !== 'round' ||
  iconManifest.style?.linejoin !== 'round'
) {
  throw new Error('Unsupported shared icon manifest or visual style');
}

const iconIds = new Set();
const symbols = iconManifest.icons.map((icon) => {
  if (!/^[a-z][a-z0-9-]*$/.test(icon.id) || iconIds.has(icon.id)) {
    throw new Error('Invalid or duplicate shared icon ID: ' + icon.id);
  }
  if (!/^icons\/[a-z0-9-]+\.svg$/.test(icon.file)) {
    throw new Error('Invalid shared icon path: ' + icon.file);
  }
  iconIds.add(icon.id);
  const source = fs.readFileSync(path.join(iconDirectory, icon.file), 'utf8')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const match = source.match(/^<svg\b([^>]*)>([\s\S]*?)<\/svg>$/);
  if (!match || !/\bviewBox=["']0 0 24 24["']/.test(match[1])) {
    throw new Error('Shared icon must use a 24 × 24 viewBox: ' + icon.id);
  }
  const body = match[2].trim();
  if (
    !body ||
    /<\/?(?!path\b|rect\b|circle\b|ellipse\b|line\b|polyline\b|polygon\b|g\b)[a-z]/i.test(body) ||
    /\b(?:href|style|on[a-z]+)\s*=/i.test(body) ||
    /url\s*\(/i.test(body)
  ) {
    throw new Error('Shared icon contains unsupported SVG content: ' + icon.id);
  }
  return `<symbol id="i-${icon.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`;
}).join('\n');

for (const file of fs.readdirSync(srcDir).filter((f) => /\.(?:html|js)$/.test(f))) {
  const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const references = [
    ...source.matchAll(/#i-([a-z][a-z0-9-]*)/g),
    ...source.matchAll(/\b(?:icon|card)\(\s*['"]([a-z][a-z0-9-]*)['"]/g),
  ];
  for (const reference of references) {
    if (!iconIds.has(reference[1])) throw new Error('Unknown shared icon in ' + file + ': ' + reference[1]);
  }
}

const iconLicense = fs.readFileSync(path.join(iconDirectory, 'LICENSE'), 'utf8').trim();
if (iconLicense.includes('-->')) throw new Error('Shared icon license cannot be embedded in an HTML comment');

const appIconFile = path.join(appRoot, 'assets', 'grokbot-x-64.png');
if (!fs.existsSync(appIconFile)) throw new Error('missing grokbot-x icon: ' + appIconFile);
const appIconDataUrl = 'data:image/png;base64,' + fs.readFileSync(appIconFile).toString('base64');

let html = fs.readFileSync(path.join(srcDir, 'shell.html'), 'utf8');
html = html.replace('/*__VERSION__*/', EDITOR_VERSION);
html = html.replace('/*__UI_ICONS__*/', () => symbols);
html = html.replace('/*__UI_ICON_LICENSE__*/', () => iconLicense);
html = html.replaceAll('/*__APP_ICON__*/', appIconDataUrl);

const parts = [
  ['STYLE', 'style.css'],
  ['LAYOUT', 'layout.js'],
  ['IMAGE_FORMAT', 'image-format.js'],
  ['FEEDBACK', 'feedback.js'],
  ['BUNDLE', 'bundle.js'],
  ['DETECTOR', 'detector.js'],
  ['HELP', 'help.js'],
  ['UI', 'ui.js'],
  ['APP', 'app.js'],
  ['AGENT', 'agent.js'],
  ['HOST', 'host.js'],
];

for (const [name, file] of parts) {
  let source = fs.readFileSync(path.join(srcDir, file), 'utf8');
  if (name === 'STYLE') {
    source += '\n' + fs.readFileSync(path.join(srcDir, 'help.css'), 'utf8');
    source += '\n' + fs.readFileSync(path.join(srcDir, 'host.css'), 'utf8');
  } else if (name === 'FEEDBACK') {
    // Classic <script> tags share one global scope; declare the version only once.
    source = `globalThis.EDITHERE_PRODUCT_VERSION = ${JSON.stringify(EDITOR_VERSION)};\n` + source;
  }
  if (name !== 'STYLE') new vm.Script(source, { filename: file });
  html = html.replace('/*__' + name + '__*/', () => source.replace(/<\/script/gi, '<\\/script'));
}

if (/\/\*__[A-Z0-9_]+__\*\//.test(html)) {
  const leftover = [...html.matchAll(/\/\*__[A-Z0-9_]+__\*\//g)].map((m) => m[0]);
  throw new Error('Unresolved asset or source placeholder: ' + leftover.join(', '));
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, html);
const bytes = Buffer.byteLength(html);
console.log(`Built ${path.relative(appRoot, outFile)} (${bytes} bytes, ${EDITOR_VERSION})`);
