// Shared helpers for the UI audit capture (read-only against product code).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(HERE, '../..');
export const OUT = path.join(HERE, 'out');
export const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Console lines collected from every renderer/main process during the run. */
export const consoleLog = [];

export async function launch({ projectDir, profileDir }) {
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-audit-profile-'));
  const app = await electron.launch({
    args: [path.join(UI_DIR, 'main.js'), `--user-data-dir=${profile}`],
    cwd: UI_DIR,
    env: { ...process.env, XLETH_PLAYWRIGHT: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  const hook = (p, tag) => {
    p.on('console', (m) => consoleLog.push({ tag, type: m.type(), text: m.text() }));
    p.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e && e.message || e) }));
  };
  app.on('window', (p) => hook(p, 'win'));
  app.process().stdout?.on('data', (d) => consoleLog.push({ tag: 'main', type: 'stdout', text: String(d) }));
  app.process().stderr?.on('data', (d) => consoleLog.push({ tag: 'main', type: 'stderr', text: String(d) }));
  for (const w of app.windows()) hook(w, 'win');

  // Welcome gate: load the (copied) project, then signal ready. Main.js shows Welcome from a ~400 ms timer;
  // closing it sooner crashes main (project_app_smoke_recipe).
  let welcome = null;
  const t0 = Date.now();
  while (!welcome && Date.now() - t0 < 60000) {
    for (const w of app.windows()) {
      if (await w.evaluate(() => !!window.xlethWelcome).catch(() => false)) { welcome = w; break; }
    }
    if (!welcome) await sleep(300);
  }
  if (!welcome) throw new Error('Welcome window never appeared');
  await sleep(2500);
  const name = path.basename(projectDir);
  const ok = await welcome.evaluate(async (dir) => window.xlethWelcome.project.load(dir), projectDir);
  if (!ok) throw new Error('project.load returned false for ' + projectDir);
  await welcome.evaluate(({ dir, name }) => window.xlethWelcome.projectReady(dir, name), { dir: projectDir, name }).catch(() => {});

  let page = null;
  const t1 = Date.now();
  while (!page && Date.now() - t1 < 90000) {
    for (const w of app.windows()) {
      if (await w.evaluate(() => typeof window.xleth === 'object' && !window.xlethWelcome).catch(() => false)) { page = w; break; }
    }
    if (!page) await sleep(400);
  }
  if (!page) throw new Error('workspace window never appeared');
  hook(page, 'workspace');
  await page.waitForSelector('[data-testid="xleth-windowing-shell"]', { timeout: 60000 });
  return { app, page, profile };
}

/** Pin the content size with a CDP device-metrics override so shots are exactly w x h CSS px at DPR 1. */
export async function setViewport(app, page, w, h) {
  await app.evaluate(({ BrowserWindow }, [W, H]) => {
    const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('index.html'));
    if (!win) return;
    win.setResizable(true); win.unmaximize(); win.setContentSize(W, H);
  }, [w, h]);
  await sleep(400);
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
  return size;
}

const FREEZE = `*,*::before,*::after{animation-play-state:paused!important;animation-duration:0s!important;transition-duration:0s!important;transition-delay:0s!important}`;
export async function freeze(page) {
  await page.evaluate((css) => {
    if (document.getElementById('__audit_freeze__')) return;
    const s = document.createElement('style'); s.id = '__audit_freeze__'; s.textContent = css; document.head.appendChild(s);
  }, FREEZE);
}
export async function unfreeze(page) { await page.evaluate(() => document.getElementById('__audit_freeze__')?.remove()); }
