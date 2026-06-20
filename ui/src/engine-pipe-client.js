'use strict';

const { EventEmitter } = require('events');
const childProcess = require('child_process');
const net = require('net');
const path = require('path');

const PIPE_NAME = '\\\\.\\pipe\\XlethEngine';
const MAX_CONNECT_ATTEMPTS = 15;
const CONNECT_BACKOFF_MS = 200;
const MAX_RESTARTS = 3;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
// Project load and export preparation can synchronously wait for proxy/audio
// teardown and legitimately exceed 10 seconds on large projects.
const COMMAND_TIMEOUT_MS = 30_000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function encodeBinary(value) {
  if (Buffer.isBuffer(value)) {
    return { __b64__: value.toString('base64') };
  }
  if (value instanceof ArrayBuffer) {
    return { __b64__: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __b64__: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    };
  }
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encodeBinary(item);
    return out;
  }
  return value;
}

function decodeBinary(value) {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '__b64__' && typeof value.__b64__ === 'string') {
      return Buffer.from(value.__b64__, 'base64');
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeBinary(item);
    return out;
  }
  return value;
}

function normalizeLegacyResult(method, result) {
  if ((method === 'getCurrentFrame' || method === 'getFrameRGBA')
      && result && Buffer.isBuffer(result.data)) {
    return { width: result.width, height: result.height, pixels: result.data };
  }
  if (method === 'getFrameBuffer' && result && Buffer.isBuffer(result.buffer)) {
    const indexOffset = Number(result.indexOffset) || 0;
    const bufferSize = Number(result.bufferSize) || 0;
    if (indexOffset + 4 <= result.buffer.length && bufferSize > 0) {
      const currentIndex = result.buffer.readInt32LE(indexOffset);
      const start = currentIndex * bufferSize;
      return {
        width: result.width,
        height: result.height,
        pixels: Buffer.from(result.buffer.subarray(start, start + bufferSize)),
      };
    }
  }
  return result === undefined ? null : result;
}

class EnginePipeClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.socket = null;
    this.ready = false;
    this.expectedShutdown = false;
    this.restartAttempts = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.receiveBuffer = Buffer.alloc(0);
    this.startPromise = null;
    this.options = null;
    this.reconnectTimer = null;
  }

  start(options = {}) {
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.options = {
      executablePath: options.executablePath
        || path.join(__dirname, '..', '..', 'build', 'xleth-engine.exe'),
      cwd: options.cwd,
      env: options.env || process.env,
      log: typeof options.log === 'function' ? options.log : console.log,
    };
    this.expectedShutdown = false;
    this.restartAttempts = 0;
    this.startPromise = this._spawnAndConnect(false).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _spawnAndConnect(isRestart) {
    const { executablePath, cwd, env } = this.options;
    const child = childProcess.spawn(executablePath, [], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      cwd: cwd || path.dirname(executablePath),
      env,
    });
    this.child = child;
    this._log(`xleth-engine.exe spawned, PID: ${child.pid}`);

    child.stderr.on('data', data => {
      const text = data.toString().trimEnd();
      if (text) this._log(`[engine-sidecar] ${text}`);
    });
    child.on('error', error => this._log(`[engine-sidecar] spawn error: ${error.message}`));
    child.on('exit', (code, signal) => this._handleExit(child, code, signal));

    try {
      await this._connectWithRetry(child);
    } catch (error) {
      if (this.child === child && child.exitCode === null) child.kill();
      throw error;
    }

    this.ready = true;
    this.emit(isRestart ? 'restarted' : 'ready');
  }

  async _connectWithRetry(child) {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
      if (this.child !== child || child.exitCode !== null) {
        throw new Error('xleth-engine.exe exited before pipe connection');
      }
      try {
        const socket = await this._connectOnce();
        if (this.child !== child) {
          socket.destroy();
          throw new Error('stale xleth-engine.exe pipe connection');
        }
        this._attachSocket(socket);
        this._log(`Pipe connected after ${attempt} retries`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < MAX_CONNECT_ATTEMPTS) {
          this._log(`Pipe connection retry ${attempt + 1}/${MAX_CONNECT_ATTEMPTS}`);
          await delay(CONNECT_BACKOFF_MS);
        }
      }
    }
    throw new Error(`Unable to connect to ${PIPE_NAME}: ${lastError?.message || 'unknown error'}`);
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(PIPE_NAME);
      const onError = error => {
        socket.removeListener('connect', onConnect);
        socket.destroy();
        reject(error);
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        resolve(socket);
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  _attachSocket(socket) {
    if (this.socket && this.socket !== socket) this.socket.destroy();
    this.socket = socket;
    this.receiveBuffer = Buffer.alloc(0);
    socket.on('data', data => this._consumeData(data));
    socket.on('error', error => {
      if (!this.expectedShutdown)
        this._log(`[engine-sidecar] pipe error: ${error.message}`);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.emit('disconnect');
    });
  }

  _consumeData(data) {
    this.receiveBuffer = this.receiveBuffer.length
      ? Buffer.concat([this.receiveBuffer, data])
      : data;

    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this._protocolFailure(`incoming frame is ${length} bytes`);
        return;
      }
      if (this.receiveBuffer.length < 4 + length) return;
      const payload = this.receiveBuffer.subarray(4, 4 + length);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length);
      try {
        this._handleMessage(JSON.parse(payload.toString('utf8')));
      } catch (error) {
        this._protocolFailure(`invalid JSON response: ${error.message}`);
        return;
      }
    }
  }

  _handleMessage(message) {
    if (!message || typeof message.id !== 'number') {
      this.emit('message', message);
      if (message && typeof message.event === 'string') this.emit(message.event, message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else if (message.notImplemented) {
      pending.reject(new Error('notImplemented'));
    } else {
      const result = normalizeLegacyResult(pending.method, decodeBinary(message.result));
      pending.resolve(result);
    }
  }

  _protocolFailure(message) {
    const error = new Error(`Engine pipe protocol error: ${message}`);
    this._log(error.message);
    this._rejectPending(error);
    if (this.socket) this.socket.destroy(error);
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  send(method, args = []) {
    if (!this.ready || !this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Engine pipe is not connected'));
    }
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, args: encodeBinary(args) }), 'utf8');
    if (payload.length > MAX_FRAME_BYTES) {
      return Promise.reject(new Error(`Engine command frame exceeds ${MAX_FRAME_BYTES} bytes`));
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Engine command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.write(Buffer.concat([header, payload]), error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  postMessage({ method, args }) {
    return this.send(method, args);
  }

  async shutdown() {
    if (this.expectedShutdown) return;
    this.expectedShutdown = true;
    clearTimeout(this.reconnectTimer);

    if (this.ready) {
      try {
        await this.send('sidecar_shutdown', []);
      } catch (error) {
        this._log(`[engine-sidecar] clean shutdown request failed: ${error.message}`);
      }
    }

    const child = this.child;
    if (child && child.exitCode === null) {
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        delay(5000),
      ]);
      if (child.exitCode === null) child.kill();
    }
    if (this.socket) this.socket.destroy();
    this.ready = false;
  }

  _handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    const error = new Error(`xleth-engine.exe exited (code ${code}, signal ${signal || 'none'})`);
    this._rejectPending(error);
    this._log(error.message);
    this.emit('exit', code, signal, this.expectedShutdown);
    if (this.expectedShutdown) return;

    if (this.restartAttempts >= MAX_RESTARTS) {
      this.emit('engine-fatal', error);
      return;
    }
    this.restartAttempts += 1;
    this._log(`Restarting xleth-engine.exe (${this.restartAttempts}/${MAX_RESTARTS})`);
    this.reconnectTimer = setTimeout(() => {
      this._spawnAndConnect(true).catch(restartError => {
        this._log(`[engine-sidecar] restart failed: ${restartError.message}`);
        if (this.child && this.child.exitCode === null) this.child.kill();
      });
    }, CONNECT_BACKOFF_MS);
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _log(message) {
    this.options?.log?.(message);
  }
}

const enginePipeClient = new EnginePipeClient();
module.exports = enginePipeClient;
module.exports.EnginePipeClient = EnginePipeClient;
module.exports._test = { encodeBinary, decodeBinary, normalizeLegacyResult };
