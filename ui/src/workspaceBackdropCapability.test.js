import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  applyWorkspaceBackdropMaterial,
  computeWorkspaceBackdropCapability,
  loadWorkspaceBackdropCapability,
  parseWindowsBuild,
  sanitizeWorkspaceBackdropPreference,
} = require('../workspaceBackdropCapability.js')

const tempDirs = []

function makeTempCachePath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xleth-${name}-`))
  tempDirs.push(dir)
  return path.join(dir, 'workspace-backdrop-capability.json')
}

function processRef(platform, version) {
  return {
    platform,
    getSystemVersion: () => version,
  }
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('workspace backdrop capability helper', () => {
  it('parses the Windows build from version strings', () => {
    expect(parseWindowsBuild('10.0.22621')).toBe(22621)
    expect(parseWindowsBuild('10.0.26100')).toBe(26100)
    expect(parseWindowsBuild('22631')).toBe(22631)
    expect(parseWindowsBuild('')).toBeNull()
  })

  it('supports native Acrylic on Windows build 22621 or newer', () => {
    expect(computeWorkspaceBackdropCapability({
      platform: 'win32',
      osVersion: '10.0.22621',
    })).toMatchObject({
      windowsBuild: 22621,
      supportsNativeSystemBackdrop: true,
      preferredMaterial: 'acrylic',
    })

    expect(computeWorkspaceBackdropCapability({
      platform: 'win32',
      osVersion: '10.0.22631',
    }).supportsNativeSystemBackdrop).toBe(true)
  })

  it('disables native Acrylic on Windows 10 / older Windows builds', () => {
    expect(computeWorkspaceBackdropCapability({
      platform: 'win32',
      osVersion: '10.0.19045',
    })).toMatchObject({
      windowsBuild: 19045,
      supportsNativeSystemBackdrop: false,
      preferredMaterial: 'none',
    })
  })

  it('reuses a matching cache entry', () => {
    const cachePath = makeTempCachePath('matching-cache')
    const cached = {
      platform: 'win32',
      osVersion: '10.0.22621',
      windowsBuild: 22621,
      supportsNativeSystemBackdrop: false,
      preferredMaterial: 'none',
    }
    fs.writeFileSync(cachePath, JSON.stringify(cached), 'utf8')

    const result = loadWorkspaceBackdropCapability({
      cachePath,
      processRef: processRef('win32', '10.0.22621'),
    })

    expect(result).toEqual(cached)
  })

  it('recomputes a stale cache when OS version/build changes', () => {
    const cachePath = makeTempCachePath('stale-cache')
    fs.writeFileSync(cachePath, JSON.stringify({
      platform: 'win32',
      osVersion: '10.0.19045',
      windowsBuild: 19045,
      supportsNativeSystemBackdrop: false,
      preferredMaterial: 'none',
    }), 'utf8')

    const result = loadWorkspaceBackdropCapability({
      cachePath,
      processRef: processRef('win32', '10.0.22621'),
    })

    expect(result).toMatchObject({
      osVersion: '10.0.22621',
      windowsBuild: 22621,
      supportsNativeSystemBackdrop: true,
      preferredMaterial: 'acrylic',
    })
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8'))).toEqual(result)
  })

  it('recomputes corrupt cache content without crashing', () => {
    const cachePath = makeTempCachePath('corrupt-cache')
    fs.writeFileSync(cachePath, '{not-json', 'utf8')

    const result = loadWorkspaceBackdropCapability({
      cachePath,
      processRef: processRef('win32', '10.0.19045'),
    })

    expect(result).toMatchObject({
      windowsBuild: 19045,
      supportsNativeSystemBackdrop: false,
    })
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8'))).toEqual(result)
  })

  it('runtime native apply failure resolves off without mutating cached OS capability', () => {
    const cachePath = makeTempCachePath('runtime-failure')
    const capability = loadWorkspaceBackdropCapability({
      cachePath,
      processRef: processRef('win32', '10.0.22621'),
    })
    const win = {
      calls: [],
      setBackgroundMaterial(material) {
        this.calls.push(material)
        if (material === 'acrylic') throw new Error('native apply failed')
      },
    }

    const result = applyWorkspaceBackdropMaterial(win, {
      capability,
      preference: 'acrylic',
    })

    expect(result.mode).toBe('off')
    expect(result.applySucceeded).toBe(false)
    expect(win.calls).toEqual(['acrylic', 'none'])
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8'))).toEqual(capability)
  })

  it('treats image as a renderer backdrop while resetting native material', () => {
    const win = {
      calls: [],
      setBackgroundMaterial(material) {
        this.calls.push(material)
      },
    }

    const result = applyWorkspaceBackdropMaterial(win, {
      capability: { supportsNativeSystemBackdrop: true },
      preference: 'image',
    })

    expect(result.mode).toBe('image')
    expect(result.requestedMaterial).toBe('none')
    expect(win.calls).toEqual(['none'])
  })

  it('treats video as a renderer backdrop while resetting native material', () => {
    const win = {
      calls: [],
      setBackgroundMaterial(material) {
        this.calls.push(material)
      },
    }

    const result = applyWorkspaceBackdropMaterial(win, {
      capability: { supportsNativeSystemBackdrop: true },
      preference: 'video',
    })

    expect(result.mode).toBe('video')
    expect(result.requestedMaterial).toBe('none')
    expect(win.calls).toEqual(['none'])
  })

  it('sanitizes image as a valid backdrop preference', () => {
    expect(sanitizeWorkspaceBackdropPreference('image')).toBe('image')
    expect(sanitizeWorkspaceBackdropPreference('video')).toBe('video')
    expect(sanitizeWorkspaceBackdropPreference('unexpected')).toBe('acrylic')
  })
})
