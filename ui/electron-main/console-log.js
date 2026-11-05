'use strict';

// ── Session console log capture & export ────────────────────────────────────
//
// Collects every log line produced since the app started — main-process lines
// (the same ones that go to startup.log, fed in through `record`) and renderer
// console output (fed in from the `console-message` webContents event) — and
// writes them out as a .txt or .md report on demand, on quit, or on a crash.
//
// ── Why a ring buffer and not a second log file ─────────────────────────────
// main.js deliberately gates the renderer→startup.log pipe behind
// XLETH_LOG_RENDERER_CONSOLE because chatty timeline components fire a log
// line — and therefore a disk write — per drag event (see the comment above
// that gate). Capturing into a bounded in-memory array keeps that cost at one
// array push and one modulo, so the capture can be on by default without
// reintroducing the write-per-interaction problem the gate exists to avoid.
// Disk is touched only when a report is actually produced.
//
// The buffer is bounded at MAX_LINES: a session left running overnight with a
// runaway warning loop must not grow the main process without limit. When it
// wraps, the report says so rather than silently presenting a partial log as
// if it were the whole session.

const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { userDataPath } = require('../runtimePaths');

// ~8k lines is a few MB at worst and comfortably covers a long editing session.
const MAX_LINES = 8000;

const SETTINGS_KEY_AUTO_EXPORT = 'consoleLogAutoExport';

// Chromium's console-message levels are numeric; name them once here rather
// than at each call site.
const RENDERER_LEVELS = ['verbose', 'info', 'warning', 'error'];

let buffer = [];
let dropped = 0;
let sessionStart = new Date();
let crashNote = null;
let exportedOnQuit = false;

let loadSettings = () => ({});
let saveSettings = () => {};
let getWin = () => null;
let log = () => {};

// ─── Capture ────────────────────────────────────────────────────────────────

function record(source, level, message) {
  if (buffer.length >= MAX_LINES) {
    // Drop oldest. splice on a large array is O(n); shifting one element at a
    // time is what a plain shift() does anyway, and at 8k entries this runs
    // once per line only after a very long session.
    buffer.shift();
    dropped += 1;
  }
  buffer.push({
    t: Date.now(),
    source,
    level: level || 'info',
    message: typeof message === 'string' ? message : String(message),
  });
}

// Wraps main.js's own log() so every main-process line lands in the buffer as
// well as in startup.log, with no second call at each of its ~40 call sites.
function wrapMainLogger(inner) {
  return (msg) => {
    record('main', 'info', msg);
    inner(msg);
  };
}

// Attach to a BrowserWindow's webContents. Safe to call for child windows too.
function attachToWebContents(webContents, label = 'renderer') {
  if (!webContents || typeof webContents.on !== 'function') return;
  webContents.on('console-message', (_e, level, message, line, source) => {
    const name = RENDERER_LEVELS[level] || 'info';
    const where = source ? ` (${source}:${line})` : '';
    record(label, name, `${message}${where}`);
  });
  // A renderer that dies takes its console with it, so note the death itself.
  webContents.on('render-process-gone', (_e, details) => {
    noteCrash(`renderer process gone: reason=${details?.reason} exitCode=${details?.exitCode}`);
  });
}

function noteCrash(reason) {
  crashNote = reason;
  record('main', 'error', `[CRASH] ${reason}`);
}

// ─── Report formatting ──────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function fileTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function clockTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    + `.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function headerFields(reason) {
  const now = new Date();
  return [
    ['XLETH version', app?.getVersion ? app.getVersion() : 'unknown'],
    ['Electron', process.versions.electron || 'n/a'],
    ['Chrome', process.versions.chrome || 'n/a'],
    ['Node', process.versions.node || 'n/a'],
    ['Platform', `${os.platform()} ${os.release()} (${os.arch()})`],
    ['CPU', os.cpus()?.[0]?.model || 'unknown'],
    ['Memory', `${Math.round(os.totalmem() / (1024 ** 3))} GB`],
    ['Session start', sessionStart.toISOString()],
    ['Report written', now.toISOString()],
    ['Session length', `${Math.round((now - sessionStart) / 1000)}s`],
    ['Export reason', reason],
    ['Lines captured', String(buffer.length)],
    ['Lines dropped', dropped > 0 ? `${dropped} (buffer limit ${MAX_LINES} reached)` : '0'],
    ['Crash detected', crashNote ? crashNote : 'no'],
  ];
}

function buildTxt(reason) {
  const lines = [];
  lines.push('='.repeat(72));
  lines.push('XLETH SESSION CONSOLE LOG');
  lines.push('='.repeat(72));
  for (const [k, v] of headerFields(reason)) {
    lines.push(`${k.padEnd(16)}: ${v}`);
  }
  lines.push('');
  lines.push('-'.repeat(72));
  lines.push('LOG');
  lines.push('-'.repeat(72));
  if (dropped > 0) {
    lines.push(`... ${dropped} earlier line(s) dropped — buffer holds the most recent ${MAX_LINES} ...`);
  }
  for (const entry of buffer) {
    lines.push(`[${clockTime(entry.t)}] [${entry.source}/${entry.level}] ${entry.message}`);
  }
  lines.push('');
  lines.push(`-- end of log (${buffer.length} lines) --`);
  return lines.join('\n');
}

function buildMd(reason) {
  const lines = [];
  lines.push('# XLETH Session Console Log');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  for (const [k, v] of headerFields(reason)) {
    lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (crashNote) {
    lines.push(`> **This session ended abnormally:** ${crashNote}`);
    lines.push('');
  }
  lines.push('## Log');
  lines.push('');
  if (dropped > 0) {
    lines.push(`_${dropped} earlier line(s) dropped — buffer holds the most recent ${MAX_LINES}._`);
    lines.push('');
  }
  lines.push('```log');
  for (const entry of buffer) {
    lines.push(`[${clockTime(entry.t)}] [${entry.source}/${entry.level}] ${entry.message}`);
  }
  lines.push('```');
  lines.push('');
  lines.push(`_${buffer.length} lines._`);
  return lines.join('\n');
}

function buildReport(format, reason) {
  return format === 'md' ? buildMd(reason) : buildTxt(reason);
}

// ─── Writing ────────────────────────────────────────────────────────────────

function logsDir() {
  return userDataPath('logs');
}

function ensureLogsDir() {
  const dir = logsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

// Keep the folder from growing forever — the auto-export-on-quit setting means
// a new file every run, and a daily user would otherwise accumulate hundreds.
function pruneOldLogs(keep = 20) {
  try {
    const dir = logsDir();
    const entries = fs.readdirSync(dir)
      .filter((name) => /^xleth-session-.*\.(txt|md)$/.test(name))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const stale of entries.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, stale.name)); } catch {}
    }
  } catch {}
}

// Writes into userData/logs without any dialog. Used by auto-export (quit and
// crash) where there is no opportunity to prompt.
function writeAutoReport(format, reason) {
  const dir = ensureLogsDir();
  const suffix = crashNote ? '-CRASH' : '';
  const file = path.join(dir, `xleth-session-${fileTimestamp()}${suffix}.${format}`);
  fs.writeFileSync(file, buildReport(format, reason), 'utf8');
  pruneOldLogs();
  return file;
}

// ─── Settings ───────────────────────────────────────────────────────────────

function getAutoExport() {
  const settings = loadSettings();
  const value = settings[SETTINGS_KEY_AUTO_EXPORT];
  // Default ON: a crash the user cannot reproduce is exactly the case this
  // feature exists for, and a log that was never captured is no use then.
  return value === undefined ? true : !!value;
}

function setAutoExport(enabled) {
  const settings = loadSettings();
  settings[SETTINGS_KEY_AUTO_EXPORT] = !!enabled;
  saveSettings(settings);
  return !!enabled;
}

// ─── Quit / crash hooks ─────────────────────────────────────────────────────

function exportOnExit(reason) {
  // before-quit can fire more than once (and will-quit follows it); one report
  // per session is what the user asked for, not one per lifecycle event.
  if (exportedOnQuit) return null;
  if (!crashNote && !getAutoExport()) return null;
  exportedOnQuit = true;
  try {
    const file = writeAutoReport('txt', reason);
    log(`[ConsoleLog] session log written to ${file}`);
    return file;
  } catch (e) {
    log(`[ConsoleLog] failed to write session log: ${e.message}`);
    return null;
  }
}

function installProcessHooks() {
  app.on('before-quit', () => { exportOnExit('app quit'); });

  app.on('child-process-gone', (_e, details) => {
    noteCrash(`child process gone: type=${details?.type} reason=${details?.reason}`);
  });

  // A main-process throw that reaches here is fatal-ish; flush before the
  // default handler tears the process down. Rethrow is deliberate — swallowing
  // it would turn a crash into a silently broken app.
  process.on('uncaughtException', (err) => {
    noteCrash(`uncaughtException: ${err?.stack || err?.message || err}`);
    exportOnExit('uncaught exception');
    throw err;
  });

  process.on('unhandledRejection', (reason) => {
    noteCrash(`unhandledRejection: ${reason?.stack || reason?.message || reason}`);
  });
}

// ─── IPC ────────────────────────────────────────────────────────────────────

function init(deps = {}) {
  loadSettings = deps.loadSettings || loadSettings;
  saveSettings = deps.saveSettings || saveSettings;
  getWin = deps.getWin || getWin;
  log = deps.log || log;
  sessionStart = new Date();

  installProcessHooks();

  ipcMain.handle('xleth:logs:getStatus', () => ({
    lines: buffer.length,
    dropped,
    maxLines: MAX_LINES,
    sessionStart: sessionStart.toISOString(),
    autoExport: getAutoExport(),
    logsDir: logsDir(),
    crash: crashNote,
  }));

  ipcMain.handle('xleth:logs:setAutoExport', (_e, enabled) => {
    const value = setAutoExport(enabled);
    // Turning it on opens the folder the logs will land in, so the setting
    // answers "and where do they go?" in the same gesture. The folder has to
    // exist before the shell can show it.
    if (value) {
      ensureLogsDir();
      try { shell.openPath(logsDir()); } catch {}
    }
    return { autoExport: value, logsDir: logsDir() };
  });

  ipcMain.handle('xleth:logs:openFolder', () => {
    ensureLogsDir();
    try { shell.openPath(logsDir()); } catch {}
    return logsDir();
  });

  // Manual export. Prompts for a location; falls back to userData/logs when no
  // window is available to parent the dialog (same fallback diagnostics.js uses).
  ipcMain.handle('xleth:logs:export', async (_e, opts = {}) => {
    const format = opts.format === 'md' ? 'md' : 'txt';
    const content = buildReport(format, 'manual export from Settings');
    const defaultName = `xleth-session-${fileTimestamp()}.${format}`;
    try {
      const win = getWin();
      if (win && dialog?.showSaveDialog) {
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
          title: 'Export session console log',
          defaultPath: path.join(logsDir(), defaultName),
          filters: format === 'md'
            ? [{ name: 'Markdown', extensions: ['md'] }]
            : [{ name: 'Text', extensions: ['txt'] }],
        });
        if (canceled || !filePath) return { cancelled: true };
        ensureLogsDir();
        fs.writeFileSync(filePath, content, 'utf8');
        return { path: filePath, lines: buffer.length };
      }
      const fallback = path.join(ensureLogsDir(), defaultName);
      fs.writeFileSync(fallback, content, 'utf8');
      return { path: fallback, lines: buffer.length };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  });

  // Reveals a written report in the OS file manager.
  ipcMain.handle('xleth:logs:reveal', (_e, filePath) => {
    try { shell.showItemInFolder(String(filePath)); } catch {}
    return true;
  });
}

module.exports = {
  init,
  record,
  wrapMainLogger,
  attachToWebContents,
  noteCrash,
  buildReport,
  getAutoExport,
  setAutoExport,
  exportOnExit,
  logsDir,
  // test-only
  _reset() { buffer = []; dropped = 0; crashNote = null; exportedOnQuit = false; sessionStart = new Date(); },
  _buffer() { return buffer; },
  MAX_LINES,
  SETTINGS_KEY_AUTO_EXPORT,
};
