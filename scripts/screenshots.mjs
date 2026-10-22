/**
 * Snímky hlavních stránek (počítač i mobil) pro vizuální kontrolu po změnách vzhledu.
 * Spustí headless Chrome nebo Edge, přihlásí se a uloží PNG do složky.
 *
 *   node scripts/screenshots.mjs [složka]
 *
 * Prostředí: BASE_URL (výchozí http://localhost:5173, vývojový web), LOGIN a PASSWORD (účet správce),
 * CHROME (cesta k prohlížeči, jinak se hledá Chrome/Edge v běžných místech). Server i web musí běžet
 * (`pnpm dev:server` a `pnpm dev:web`). Potřebuje Node 22 nebo novější (vestavěný WebSocket).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const out = process.argv[2] ?? 'screenshots';
const base = process.env.BASE_URL ?? 'http://localhost:5173';
const login = process.env.LOGIN;
const password = process.env.PASSWORD;
if (!login || !password) {
  console.error('Nastav LOGIN a PASSWORD (účet správce) v prostředí.');
  process.exit(1);
}
const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = candidates.find((p) => existsSync(p));
if (!chromePath) {
  console.error('Nenašel jsem Chrome ani Edge; nastav proměnnou CHROME.');
  process.exit(1);
}

const PAGES = [
  ['lobby', '/'],
  ['stoly', '/stoly'],
  ['penezenka', '/penezenka'],
  ['statistiky', '/statistiky'],
  ['nastaveni', '/nastaveni'],
  ['vecery', '/vecery'],
  ['admin-napojeni', '/admin/napojeni'],
  ['admin-logo', '/admin/logo'],
  ['admin-sablony', '/admin/sablony'],
  ['admin-pokladna', '/admin/pokladna'],
  ['admin-nastaveni', '/admin/nastaveni'],
];
const SIZES = [
  ['pc', 1100, 900],
  ['mobil', 390, 800],
];

mkdirSync(out, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(path.join(tmpdir(), 'kb-shots-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60 && !list; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    await sleep(250);
  }
}
if (!list) {
  chrome.kill();
  console.error('Prohlížeč se nespustil.');
  process.exit(1);
}
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id);
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Page.navigate', { url: `${base}/prihlaseni` });
await sleep(1500);
const status = await send('Runtime.evaluate', { expression: `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:${JSON.stringify(login)},password:${JSON.stringify(password)}})}).then(r=>r.status)`, awaitPromise: true, returnByValue: true });
if (status.result?.result?.value !== 200) {
  console.error('Přihlášení se nezdařilo (stav ' + status.result?.result?.value + ').');
  chrome.kill();
  process.exit(1);
}
for (const [sizeName, w, h] of SIZES) {
  for (const [name, url] of PAGES) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Page.navigate', { url: base + url });
    await sleep(2500);
    const height = (await send('Runtime.evaluate', { expression: 'Math.max(document.documentElement.scrollHeight, 600)', returnByValue: true })).result.result.value;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: Math.min(height, 4000), deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(out, `${name}-${sizeName}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log('uloženo', `${name}-${sizeName}.png`);
  }
}
ws.close();
chrome.kill();
process.exit(0);
