import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { once } from 'events';

const mediaServer = await import('./media-server.js');

// Real server on 127.0.0.1, real files in a temp dir: <tmp>/root is the only allowed root.
let tmp, root, outside, server, port, processErrors;
const token = mediaServer.getMediaToken();
const onProcessError = (err) => processErrors.push(err);

function get(filePath, { tok = token, headers = {} } = {}) {
  const qs = new URLSearchParams({ path: filePath, token: tok });
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/media?${qs}`, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

beforeAll(async () => {
  processErrors = [];
  process.on('uncaughtException', onProcessError);
  process.on('unhandledRejection', onProcessError);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-media-'));
  root = path.join(tmp, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.from('0123456789'));
  outside = path.join(tmp, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  mediaServer.init({ log: () => {}, getRoots: async () => [root] });
  server = mediaServer.startMediaServer();
  await once(server, 'listening');
  port = server.address().port;
});

afterAll(() => {
  server.close();
  process.off('uncaughtException', onProcessError);
  process.off('unhandledRejection', onProcessError);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('media server', () => {
  it('binds to 127.0.0.1 and sends no wildcard CORS header', async () => {
    expect(server.address().address).toBe('127.0.0.1');
    const res = await get(path.join(root, 'clip.mp4'));
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('403s without the token or with a wrong one', async () => {
    expect((await get(path.join(root, 'clip.mp4'), { tok: '' })).status).toBe(403);
    expect((await get(path.join(root, 'clip.mp4'), { tok: 'x'.repeat(token.length) })).status).toBe(403);
  });

  it('403s for a file outside the allowed roots', async () => {
    const res = await get(outside);
    expect(res.status).toBe(403);
    expect(res.body.toString()).not.toContain('secret');
  });

  it("403s for a '..' escape", async () => {
    expect((await get(path.join(root, '..', 'secret.txt'))).status).toBe(403);
  });

  it('403s for a symlink inside a root that points outside it', async () => {
    // A directory junction needs no admin rights on Windows; elsewhere it is a plain dir symlink.
    const link = path.join(root, 'escape');
    fs.symlinkSync(tmp, link, 'junction');
    expect((await get(path.join(link, 'secret.txt'))).status).toBe(403);
  });

  it('200s for a whole allowed file', async () => {
    const res = await get(path.join(root, 'clip.mp4'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.body.toString()).toBe('0123456789');
  });

  it('206s for valid ranges (explicit, open-ended, suffix, end past EOF)', async () => {
    const file = path.join(root, 'clip.mp4');
    const cases = [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10']];
    for (const [range, body, contentRange] of cases) {
      const res = await get(file, { headers: { Range: range } });
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(contentRange);
      expect(res.body.toString()).toBe(body);
    }
  });

  it('416s for malformed or unsatisfiable ranges without a process error', async () => {
    const file = path.join(root, 'clip.mp4');
    for (const range of ['garbage', 'bytes=', 'bytes=-', 'bytes=5-2', 'bytes=10-', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1']) {
      const res = await get(file, { headers: { Range: range } });
      expect(res.status, range).toBe(416);
      expect(res.headers['content-range']).toBe('bytes */10');
    }
    expect(processErrors).toEqual([]);
  });

  it('404s for a missing file or a directory', async () => {
    expect((await get(path.join(root, 'nope.mp4'))).status).toBe(404);
    expect((await get(root)).status).toBe(404);
  });
});
