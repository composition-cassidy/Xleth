import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module reaches for electron and for userDataPath at require time, so
// both are stubbed before it loads. Nothing here touches a real app instance.
vi.mock('electron', () => ({
  app: { on: vi.fn(), getVersion: () => '1.2.3' },
  ipcMain: { handle: vi.fn() },
  dialog: {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('../runtimePaths', () => ({
  userDataPath: (name) => `/tmp/xleth-test/${name}`,
}));

const consoleLog = await import('./console-log.js');

describe('console-log session buffer', () => {
  beforeEach(() => {
    consoleLog._reset();
  });

  it('records lines from both processes with their source', () => {
    consoleLog.record('main', 'info', 'engine ready');
    consoleLog.record('renderer', 'error', 'boom');

    const report = consoleLog.buildReport('txt', 'test');
    expect(report).toContain('[main/info] engine ready');
    expect(report).toContain('[renderer/error] boom');
  });

  it('bounds the buffer and reports how many lines were dropped', () => {
    const over = consoleLog.MAX_LINES + 25;
    for (let i = 0; i < over; i++) consoleLog.record('main', 'info', `line ${i}`);

    expect(consoleLog._buffer().length).toBe(consoleLog.MAX_LINES);

    // A truncated log that did not say it was truncated would read as a
    // complete session — the one thing a bug report must not do.
    const report = consoleLog.buildReport('txt', 'test');
    expect(report).toContain('Lines dropped');
    expect(report).toContain('25 (buffer limit');
    expect(report).not.toContain('line 0 ');
    expect(report).toContain(`line ${over - 1}`);
  });

  it('writes a markdown report with a header table and a fenced log block', () => {
    consoleLog.record('main', 'info', 'hello');
    const md = consoleLog.buildReport('md', 'manual');

    expect(md).toContain('# XLETH Session Console Log');
    expect(md).toContain('| Field | Value |');
    // The value comes from Electron's app, which is not available outside an
    // Electron runtime — what matters here is that the row is emitted.
    expect(md).toContain('| XLETH version |');
    expect(md).toContain('```log');
    expect(md).toContain('[main/info] hello');
  });

  it('escapes a pipe in a header value so the markdown table survives it', () => {
    const md = consoleLog.buildReport('md', 'a | b');
    expect(md).toContain('a \\| b');
  });

  it('surfaces a crash in both report formats', () => {
    consoleLog.noteCrash('renderer process gone: reason=crashed');

    expect(consoleLog.buildReport('txt', 'crash')).toContain('Crash detected');
    expect(consoleLog.buildReport('md', 'crash')).toContain('ended abnormally');
    // noteCrash also lands in the log body, so the timeline shows where it hit.
    expect(consoleLog.buildReport('txt', 'crash')).toContain('[CRASH]');
  });

  it('wraps a main logger so each line is both written through and captured', () => {
    const inner = vi.fn();
    const log = consoleLog.wrapMainLogger(inner);

    log('startup step');

    expect(inner).toHaveBeenCalledWith('startup step');
    expect(consoleLog.buildReport('txt', 'test')).toContain('[main/info] startup step');
  });
});
