// Guard: no stylesheet may escape the cascade layers.
//
// Unlayered CSS beats every @layer, so one stray sheet would silently override
// the ui-kit (`kit` layer). This test fails if any renderer stylesheet, or any
// CSS import, is not layered. See styles/layers.css and ui/DESIGN.md section 2.
//
// A stylesheet is layered when EITHER
//   - every top-level construct in it is an `@layer …;` statement, an
//     `@import … layer(…)`, or an `@layer name { … }` block; OR
//   - it is only ever pulled in through `@import '…' layer(…)` from another
//     stylesheet (app.css, which is too large to edit in place).
// @fontsource/* sheets contain only @font-face, which is not part of the cascade.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..', '..')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** Top-level constructs of a stylesheet: [{ head, kind: 'block' | 'stmt' }]. */
function topLevel(css) {
  const items = []
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let depth = 0
  let start = 0
  let inStr = null
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') i += 1
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === '{') {
      if (depth === 0) items.push({ head: src.slice(start, i).trim(), kind: 'block' })
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) start = i + 1
    } else if (c === ';' && depth === 0) {
      items.push({ head: src.slice(start, i).trim(), kind: 'stmt' })
      start = i + 1
    }
  }
  return items
}

const isLayeredConstruct = (it) =>
  (it.kind === 'block' && /^@layer\s+[\w-]+$/.test(it.head)) ||
  (it.kind === 'stmt' && /^@layer\s+[\w-]+(\s*,\s*[\w-]+)*$/.test(it.head)) ||
  (it.kind === 'stmt' && /^@import\b.*\blayer\(\s*[\w-]+\s*\)/.test(it.head))

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/')

const files = walk(SRC)
const cssFiles = files.filter((f) => f.endsWith('.css'))
const codeFiles = files.filter((f) => /\.(js|jsx|ts|tsx|mjs)$/.test(f) && !/\.(test|spec)\./.test(f))

// Targets of `@import './x.css' layer(…)`: layered by their importer.
const layeredByImport = new Set()
for (const f of cssFiles) {
  for (const it of topLevel(fs.readFileSync(f, 'utf8'))) {
    const m = /^@import\s+(?:url\()?['"]([^'"]+)['"]\)?.*\blayer\(/.exec(it.head)
    if (m && m[1].startsWith('.')) layeredByImport.add(path.resolve(path.dirname(f), m[1]))
  }
}

describe('cascade layers', () => {
  it('declares the layer order in layers.css', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles', 'layers.css'), 'utf8')
    expect(topLevel(css).map((i) => i.head)).toContain('@layer reset, legacy, tokens, kit')
  })

  it('imports layers.css first in main.jsx so it ranks the layers', () => {
    const main = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8')
    const firstImport = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/m.exec(main)
    expect(firstImport && firstImport[1]).toBe('./styles/layers.css')
  })

  it('has no unlayered stylesheet', () => {
    const offenders = []
    for (const f of cssFiles) {
      if (layeredByImport.has(f)) continue
      const bad = topLevel(fs.readFileSync(f, 'utf8')).filter((it) => !isLayeredConstruct(it))
      if (bad.length) offenders.push(`${rel(f)}: ${bad.length} unlayered top-level construct(s), first "${bad[0].head.slice(0, 60)}"`)
    }
    expect(offenders).toEqual([])
  })

  it('imports every stylesheet through a layered path', () => {
    const offenders = []
    const importRe = /(?:^|\s)import\s+(?:[^'"\n]*from\s+)?['"]([^'"]+\.css)['"]|import\(\s*['"]([^'"]+\.css)['"]\s*\)/g
    for (const f of codeFiles) {
      const text = fs.readFileSync(f, 'utf8')
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] || m[2]
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(f), spec)
          if (layeredByImport.has(target)) offenders.push(`${rel(f)} imports ${spec} directly, bypassing its layer() import`)
        } else if (!/^@fontsource\//.test(spec)) {
          offenders.push(`${rel(f)} imports package CSS "${spec}" unlayered; wrap it with @import … layer(legacy) in a local .css file`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
