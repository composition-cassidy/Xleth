import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uiRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(uiRoot, '..')
const workerPath = path.join(uiRoot, 'addon-worker.js')
const bridgeDir = path.join(repoRoot, 'bridge', 'build', 'Release')
const ffmpegDir = path.join(repoRoot, 'vendor', 'ffmpeg', 'bin')

function startWorker() {
  return new Promise((resolve, reject) => {
    let ready = false
    let stderr = ''
    let settled = false

    const child = fork(workerPath, [], {
      env: {
        ...process.env,
        XLETH_BRIDGE_DIR: bridgeDir,
        XLETH_FFMPEG_DIR: ffmpegDir,
        PATH: [bridgeDir, ffmpegDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        reject(new Error(`addon worker did not become ready. stderr:\n${stderr}`))
      }
    }, 20000)

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.once('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    })

    child.once('exit', (code, signal) => {
      if (!settled && !ready) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`addon worker exited before ready: code=${code} signal=${signal}. stderr:\n${stderr}`))
      }
    })

    child.on('message', (message) => {
      if (message?.ready && !settled) {
        ready = true
        settled = true
        clearTimeout(timeout)
        resolve({ child, getStderr: () => stderr })
      }
    })
  })
}

function callWorker(child, method, args = []) {
  return new Promise((resolve, reject) => {
    const id = `${method}-${Date.now()}-${Math.random()}`
    const timeout = setTimeout(() => {
      child.off('message', onMessage)
      reject(new Error(`addon worker did not answer ${method}`))
    }, 10000)

    function onMessage(message) {
      if (message?.id !== id) return
      clearTimeout(timeout)
      child.off('message', onMessage)
      resolve(message)
    }

    child.on('message', onMessage)
    child.send({ id, method, args }, (error) => {
      if (error) {
        clearTimeout(timeout)
        child.off('message', onMessage)
        reject(error)
      }
    })
  })
}

function stopWorker(child) {
  if (child.connected) {
    child.disconnect()
  }
  child.kill()
}

describe('addon worker routing dispatch', () => {
  it('recognizes output routing methods and still rejects unknown methods as notImplemented', async () => {
    const { child } = await startWorker()

    try {
      const getRouting = await callWorker(child, 'timeline_getRouting')
      expect(getRouting.notImplemented).not.toBe(true)

      const setTrackOutputRoute = await callWorker(child, 'timeline_setTrackOutputRoute', [1, -1])
      expect(setTrackOutputRoute.notImplemented).not.toBe(true)

      const missing = await callWorker(child, 'timeline_missingRoutingMethodForTest')
      expect(missing).toMatchObject({
        result: null,
        notImplemented: true,
      })
    } finally {
      stopWorker(child)
    }
  }, 30000)
})
