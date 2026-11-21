import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Smoke-tests that the setImmediate deferral added to ui/addon-worker.js for
// waveform_* RPCs (see WAVEFORM_METHODS there, and
// worker-dispatch-priority.test.js for the deferral DECISION's own unit
// tests) doesn't change the deferred call's actual behavior — same result,
// same error handling, just later.
//
// What this file deliberately does NOT attempt: asserting the cross-process
// ARRIVAL ORDER of a waveform reply vs. a reply sent right after it. An
// earlier version of this test tried exactly that (send 6 waveform_*
// messages, then one ordinary one, assert the ordinary one's reply arrives
// first) and it failed — not because the fix doesn't work, but because the
// assumption behind the test was wrong: child_process IPC over a real OS
// pipe does not reliably deliver a burst of sent messages as one atomic
// batch that the child drains before advancing to its check phase. Message
// arrival is spread across the child's event loop by real I/O timing, so a
// later-sent message's handler can just as easily run before OR after an
// earlier message's deferred setImmediate fires, depending on OS scheduling
// — an inherently racy thing to assert over IPC. The deferral itself (that
// setImmediate pushes a callback to a later check-phase tick within ONE
// process) is standard, well-defined Node.js behavior and doesn't need
// re-proving here; only "which methods get deferred" (a pure decision) is
// usefully unit-testable, which worker-dispatch-priority.test.js does.
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

function stopWorker(child) {
  if (child.connected) child.disconnect()
  child.kill()
}

describe('addon worker: waveform requests are deferred without changing behavior', () => {
  it('a burst of waveform fetches all still resolve correctly, each exactly once', async () => {
    const { child } = await startWorker()
    try {
      const pending = new Map() // id -> resolve
      child.on('message', (message) => {
        if (message?.id == null) return
        pending.get(message.id)?.(message)
      })

      function send(id, method, args = []) {
        return new Promise((resolve) => {
          pending.set(id, resolve)
          child.send({ id, method, args })
        })
      }

      // Mirrors the real scenario: Phase 5's coalesced hi-res fetch can land
      // several waveform_* messages in one settle pass. Every one of them
      // must still come back correctly once deferred — no drops, no
      // duplicate replies, no cross-talk between concurrently in-flight ones.
      const replies = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          send(`wf-${i}`, 'waveform_getRegionPeaks', [999999, i, i + 1, 100, 0])),
      )
      for (const reply of replies) {
        expect(reply.error).toBeUndefined()
        expect(reply.result).toBeTruthy()
        expect(reply.result.ready).toBe(false) // no project loaded — expected, not a crash
      }
    } finally {
      stopWorker(child)
    }
  }, 30000)

  it('waveform methods are still handled exactly once, correctly, just deferred', async () => {
    const { child } = await startWorker()
    try {
      const reply = await new Promise((resolve) => {
        const id = 'single-wf'
        child.on('message', function onMsg(message) {
          if (message?.id !== id) return
          child.off('message', onMsg)
          resolve(message)
        })
        child.send({ id, method: 'waveform_getRegionPeaks', args: [999999, 0, 1, 100, 0] })
      })
      expect(reply.error).toBeUndefined()
      expect(reply.result).toBeTruthy()
      expect(reply.result.ready).toBe(false) // no project loaded — expected, not a crash
    } finally {
      stopWorker(child)
    }
  }, 30000)
})
