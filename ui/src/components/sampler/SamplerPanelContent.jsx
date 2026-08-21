import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import RootNotePicker from './RootNotePicker.jsx'
import SamplerWaveform from './SamplerWaveform.jsx'
import SlotList, { MAX_SLOTS } from './SlotList.jsx'
import PreviewRoutingControl from './PreviewRoutingControl.jsx'
import Knob from './Knob.jsx'
import SamplerModTray from './modulation/SamplerModTray.jsx'
import { useModTarget } from './modulation/useModTarget.js'
import { TARGET_SLOT_MANGLE_AMOUNT, TARGET_SLOT_MANGLE_MIX } from './modulation/modTargets.js'
import useSamplerModulationStore from '../../stores/samplerModulationStore.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { nudgeEventFor, applyRecordFor } from './autoLoopTelemetry.js'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry'
import { PANEL_CATALOG } from '../../windowing/registry/panelCatalog'
import { MIN_PANEL_HEIGHT } from '../../windowing/managers/ResizeManager'

const WAVE_WIDTH = 800
const WAVE_HEIGHT = 158

// Main <-> Playback tab transition timing. The outgoing pane fades/slides out
// over TAB_ANIM_EXIT_MS while the incoming pane fades/slides in over
// TAB_ANIM_ENTER_MS (the two overlap — a crossfade, not a hard cut); the
// floating window's own resize is given a touch longer so it settles just
// after the content does. Same ease-out-quint the rest of the windowing
// system's own motion uses (xleth-sample-selector-drawer, xleth-windowing-shell).
const TAB_ANIM_EXIT_MS = 200
const TAB_ANIM_ENTER_MS = 240
const TAB_ANIM_RESIZE_MS = 260
const TAB_ANIM_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

const ARP_DIRS = ['up', 'down', 'updown', 'sticky']
const ARP_DIR_TITLES = { up: 'Up', down: 'Down', updown: 'Up + Down', sticky: 'Sticky' }
const ARP_DIR_ICONS = {
  up:     <path d="M7,11 L7,4 M4,7 L7,4 L10,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  down:   <path d="M7,4 L7,11 M4,8 L7,11 L10,8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  updown: <path d="M7,2 L7,13 M4,5 L7,2 L10,5 M4,10 L7,13 L10,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  sticky: <path d="M4,3 L7,1 L10,3 M7,1 L7,7 M4,12 L7,14 L10,12 M7,14 L7,8 M5,7.5 L9,7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
}

// PREP algorithms. Values are engine StretchMethod ids — the same five the
// timeline's clip stretch uses. Ordered by how often they are the right answer,
// not by id.
const PREP_ALGOS = [
  { v: 2, l: 'Rubber Band' },
  { v: 3, l: 'WSOLA' },
  { v: 1, l: 'TD-PSOLA' },
  { v: 5, l: 'WORLD' },
  { v: 4, l: 'Phase Vocoder' },
]

// SampleLoopMode: 0 = Forward, 1 = PingPong, 2 = Reverse.
const LOOP_MODES = [
  { v: 0, l: 'FWD' },
  { v: 1, l: 'P-P' },
  { v: 2, l: 'REV' },
]

// ── MANGLE ────────────────────────────────────────────────────────────────
// Per-note, per-slot warp FX. Ids MUST match xleth::mangle::Mode in
// engine/src/audio/MangleDsp.h — they are persisted in the project file, so
// the enum is append-only and this list mirrors it 1:1.
//
// Mode 0 (Off) is the bypass and lives outside the groups so it is always the
// first option, whatever the group order.
const MANGLE_OFF = 0
// Chain cap — MUST match xleth::mangle::kMaxInstances in engine/src/audio/MangleDsp.h.
const MANGLE_MAX = 4
const MANGLE_GROUPS = [
  {
    label: 'Alt',
    modes: [
      { v: 1,  l: 'Sync' },
      { v: 2,  l: 'Bend +' },
      { v: 3,  l: 'Bend −' },
      { v: 4,  l: 'Bend +/−' },
      { v: 5,  l: 'PWM' },
      { v: 6,  l: 'Asym +' },
      { v: 7,  l: 'Asym −' },
      { v: 8,  l: 'Asym +/−' },
      { v: 9,  l: 'Flip' },
      { v: 10, l: 'Mirror' },
      { v: 11, l: 'Quantize' },
      { v: 12, l: 'Even' },
      { v: 13, l: 'Odd' },
    ],
  },
  {
    label: 'Filter',
    modes: [
      { v: 14, l: 'LPF' },
      { v: 15, l: 'HPF' },
      { v: 16, l: 'BPF' },
      { v: 17, l: 'Notch' },
    ],
  },
  {
    label: 'Distortion',
    modes: [
      { v: 18, l: 'Tube' },
      { v: 19, l: 'Soft Clip' },
      { v: 20, l: 'Hard Clip' },
      { v: 21, l: 'Diode 1' },
      { v: 22, l: 'Diode 2' },
      { v: 23, l: 'Linear Fold' },
      { v: 24, l: 'Sine Fold' },
      { v: 25, l: 'Zero-Square' },
      { v: 26, l: 'Asym' },
      { v: 27, l: 'Rectify' },
      { v: 28, l: 'Sine Shaper' },
      { v: 29, l: 'Stomp Box' },
      { v: 30, l: 'Tape Sat.' },
      { v: 31, l: 'Soft Sat.' },
    ],
  },
  {
    label: 'Modulation',
    modes: [
      { v: 32, l: 'FM' },
      { v: 33, l: 'PD' },
      { v: 34, l: 'AM' },
      { v: 35, l: 'RM' },
    ],
  },
]

// One-line hints, keyed by mode id. The ALT and MODULATION groups in
// particular are not self-describing from their names alone.
const MANGLE_HINTS = {
  1: 'Oscillator hard sync — the read head snaps back once per note cycle',
  2: 'Read phase bent toward the start of the sample',
  3: 'Read phase bent toward the end of the sample',
  4: 'Read phase bent outward from the midpoint',
  5: 'Read head advances then stalls each cycle — hollow, square-like',
  6: 'Each note period skewed fast-then-slow',
  7: 'Each note period skewed slow-then-fast',
  8: 'Skew direction alternates every cycle',
  9: 'Read direction reverses partway through each cycle',
  10: 'Read head ping-pongs inside a local window',
  11: 'Bit-depth reduction, 16 bits down to 1',
  12: 'Comb against a half-period-delayed copy — even harmonics',
  13: 'Comb against an inverted half-period copy — odd harmonics',
  14: 'Low pass, cutoff key-tracked and swept by Amount',
  15: 'High pass, cutoff key-tracked and swept by Amount',
  16: 'Band pass, centre key-tracked and swept by Amount',
  17: 'Notch, centre key-tracked and swept by Amount',
  27: 'Amount blends half-wave to full-wave rectification',
  32: 'Sine at the note frequency modulates read speed — vibrato to growl',
  33: 'Casio-style per-cycle phase kink',
  34: 'Unipolar tremolo at audio rate',
  35: 'Bipolar ring modulation at the note frequency',
}

// Modes that bend the READ HEAD rather than shape the sample — mirrors
// xleth::mangle::isPositionMode. The engine resolves every warp in a chain
// before any shaper (a bent head re-reads the source buffer, so it cannot take
// a shaped sample as its input), which the chain hint below has to reflect
// rather than promise a left-to-right flow the audio does not follow.
const MANGLE_WARP_MODES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 32, 33])

const mangleModeLabel = (v) => {
  if (!v) return 'Off'
  for (const g of MANGLE_GROUPS) {
    const hit = g.modes.find((m) => m.v === v)
    if (hit) return hit.l
  }
  return 'Off'
}

// The FILTER group sweeps cutoff AROUND a key-tracked base, so its Amount
// midpoint (not its minimum) is the neutral setting. Every other group treats
// Amount 0 as "off", which is worth telling the user rather than making them
// discover it by ear.
const mangleAmountIsBipolar = (v) => v >= 14 && v <= 17

// PREP is bypassed at unity stretch and zero shift — mirrors the engine's
// SampleSlot::prepIsBypassed(), which is what decides whether a bake runs.
const prepIsBypassed = (s) =>
  Math.abs((s.prepStretch ?? 1) - 1) < 1e-6 && Math.abs(s.prepShiftCents ?? 0) < 1e-6

const TDIVS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64']
const TDIV_VALUES = { '1/1': 1, '1/2': 2, '1/4': 4, '1/8': 8, '1/16': 16, '1/32': 32, '1/64': 64 }
const TDIV_LABELS = { 1: '1/1', 2: '1/2', 4: '1/4', 8: '1/8', 16: '1/16', 32: '1/32', 64: '1/64' }

// Voice count is clamped to the engine's [1, 32] polyphony window.
const clampVoiceCount = (v) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 32
  return Math.max(1, Math.min(32, n))
}

// The amp/pitch envelopes and three drawable LFOs are gone — ENV 1 is the amp
// envelope and every other envelope/LFO is a modulation source in the tray.
const emptySettings = {
  rootNote: 60,
  loopEnabled: false, loopStart: 0, loopEnd: 0,
  loopMode: 0, exitLoopOnRelease: false,
  mangleChain: [],
  prepAlgorithm: 2, prepStretch: 1, prepShiftCents: 0,
  crossfadeEnabled: true,
  smpStart: 0, smpLength: 0, declickMs: 1.5,
  fadeInMs: 0, fadeOutMs: 0,
  crossfadeSamples: 5000,
  dcOffsetRemoved: false, normalized: false, polarityReversed: false, reversed: false,
  monoEnabled: false, portamentoEnabled: false, portamentoTimeMs: 100,
  voiceCount: 32, legatoEnabled: false, portamentoMode: 0, portamentoCurve: 0,
  arpEnabled: false, arpTempoSync: true, arpDivision: 8,
  arpFreeTimeMs: 125, arpGate: 0.8, arpRange: 1, arpDirection: 0,
}

// ── Layout primitives styled per mock ─────────────────────────────────────
const SAMPLER_KNOB_APPEARANCE = {
  tickStyle: 'none',
  glyph: 'rotary-arrow',
  accentGlow: false,
}

// `modTarget` is the OPT-IN modulation registration. Every sampler knob routes
// through here, but only the ones that pass a registration become drop targets;
// the rest get `mod = null` and are the plain Knob they have always been.
function SamplerKnob({ modTarget, ...props }) {
  const mod = useModTarget(modTarget, { value: props.value, min: props.min, max: props.max })
  return <Knob {...SAMPLER_KNOB_APPEARANCE} {...props} mod={mod} />
}

function Tabs({ tabs, active, onSelect, sm }) {
  return (
    <div className={`sampler-tabs${sm ? ' sampler-tabs--sm' : ''}`}>
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={`sampler-tab${active === t.id ? ' is-active' : ''}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function Seg({ opts, val, set, sm }) {
  return (
    <div className={`sampler-seg${sm ? ' sampler-seg--sm' : ''}`}>
      {opts.map((o) => (
        <button
          type="button"
          key={o.v}
          onClick={() => set(o.v)}
          className={`sampler-seg-option${val === o.v ? ' is-active' : ''}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

function Chk({ val, set, label }) {
  return (
    <label className="sampler-check">
      <input
        type="checkbox"
        checked={!!val}
        onChange={(e) => set(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function Sel({ val, set, opts }) {
  return (
    <select
      value={val}
      onChange={(e) => set(e.target.value)}
      className="sampler-select"
    >
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

// Select over {v, l} pairs (Sel above is string-only, and PREP's options carry
// numeric engine ids that must survive the round trip).
function SelKV({ val, set, opts }) {
  return (
    <select
      value={String(val)}
      onChange={(e) => set(Number(e.target.value))}
      className="sampler-select"
    >
      {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  )
}

// Select over grouped {label, modes:[{v,l}]} — MANGLE's four families are what
// make a 36-entry list navigable, so the grouping is structural, not decor.
function SelGrouped({ val, set, groups, offLabel, className }) {
  return (
    <select
      value={String(val)}
      onChange={(e) => set(Number(e.target.value))}
      className={className || 'sampler-select'}
    >
      <option value={MANGLE_OFF}>{offLabel}</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.modes.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

function SectionLabel({ children }) {
  return (
    <div className="sampler-section-label">{children}</div>
  )
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, '0')}`
}

function ProcessButton({ label, active, onClick, children }) {
  return (
    <button type="button" className={`sampler-process-button${active ? ' is-active' : ''}`} onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function SamplerPanelContent({ regionId, onClose }) {
  const [tab, setTab] = useState('main')
  const [region, setRegion] = useState(null)
  const [audioInfo, setAudioInfo] = useState(null)
  // Project tempo — the modulation rack needs it to display BPM-synced times.
  const [bpm, setBpm] = useState(140)
  const [settings, setSettings] = useState(emptySettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // ── Tab switch: exit, then swap+resize, then enter ───────────────────────
  // Strictly sequential — the outgoing pane finishes leaving before the
  // incoming one is even mounted, so they never overlap or cross paths, and
  // the panel stays at its CURRENT size for the whole exit (a tab is only
  // ever shown at its own full size, never squeezed by the other tab's
  // window). `tab` itself only flips once the exit has finished, which is
  // also the moment the auto-shrink effect below fires and the entrance
  // animation starts — so the resize and the entrance play together, right
  // after the old content is gone. Reversed pairs: leaving MAIN moves down +
  // fades (entering MAIN is its mirror, up + fade-in); leaving PLAYBACK
  // slides out left + fades (entering PLAYBACK is its mirror, in from the
  // left) — so Playback -> Main plays as the exact reverse of Main -> Playback.
  const [tabAnimPhase, setTabAnimPhase] = useState('idle') // 'idle' | 'exiting' | 'entering'
  const pendingTabRef = useRef(null)
  const exitTimerRef = useRef(null)
  const enterTimerRef = useRef(null)

  useEffect(() => () => {
    clearTimeout(exitTimerRef.current)
    clearTimeout(enterTimerRef.current)
  }, [])

  const handleSelectTab = (nextTab) => {
    if (pendingTabRef.current === nextTab) return
    if (nextTab === tab) {
      if (tabAnimPhase === 'idle') return
      // Clicked back to the tab still on screen — abort the outgoing switch.
      clearTimeout(exitTimerRef.current)
      clearTimeout(enterTimerRef.current)
      pendingTabRef.current = null
      setTabAnimPhase('idle')
      return
    }
    pendingTabRef.current = nextTab
    setTabAnimPhase('exiting')
    clearTimeout(exitTimerRef.current)
    exitTimerRef.current = setTimeout(() => {
      setTab(nextTab)
      pendingTabRef.current = null
      setTabAnimPhase('entering')
      clearTimeout(enterTimerRef.current)
      enterTimerRef.current = setTimeout(() => setTabAnimPhase('idle'), TAB_ANIM_ENTER_MS)
    }, TAB_ANIM_EXIT_MS)
  }

  // ── Size the window to the active tab ────────────────────────────────────
  // MAIN is the tall tab (slots + waveform + prep/process/trim/loop/mangle,
  // which scrolls); PLAYBACK is short and fits its content exactly, so a
  // window sized for main leaves a wall of empty space under it. Each tab
  // therefore has ONE height, derived rather than remembered:
  //   main     -> the catalog's default height, the panel's full size
  //   playback -> chrome + the measured content, clamped to that same ceiling
  //
  // Derived, not remembered, because the sampler is `resizable: false` — there
  // is no user-chosen size to preserve — and because panel layout is persisted:
  // a remembered "restore to" height lives in a ref that dies with the panel, so
  // quitting while on playback used to bake the short height in and leave MAIN
  // permanently squashed. Recomputing from the catalog every time is self-healing.
  //
  // useLayoutEffect, NOT useEffect + requestAnimationFrame: it runs after the DOM
  // commit (so scrollHeight is already valid, no rAF needed) and, critically, it
  // survives StrictMode. The old rAF version never ran at all — StrictMode's
  // setup/cleanup/setup double-invoke cancelled the frame in the cleanup, and the
  // second setup early-returned on a `prevTabRef` it had already advanced. There
  // is no prevTab guard here at all: the body is idempotent, and
  // resizeFloatingPanel already no-ops when the geometry is unchanged.
  const scrollRef = useRef(null)
  const panelContentRef = useRef(null)
  const resizeAnimTimerRef = useRef(null)

  useLayoutEffect(() => {
    const registry = usePanelRegistry.getState()
    const panel = registry.panels.sampler
    const contentEl = panelContentRef.current
    const scrollEl = scrollRef.current
    if (!panel || panel.mode !== 'floating' || !contentEl || !scrollEl) return

    const frameEl = scrollEl.closest('.xleth-panel-frame[data-panel-id="sampler"]')
    if (!frameEl) return

    const fullHeight = PANEL_CATALOG.sampler.defaultFloating.height
    let target = fullHeight
    if (tab === 'playback') {
      // Chrome (titlebar + tabbar) is height-independent, so this stays correct
      // whatever size the window happens to be mid-transition.
      const chromeHeight = frameEl.clientHeight - scrollEl.clientHeight
      target = Math.min(fullHeight, Math.max(
        MIN_PANEL_HEIGHT,
        Math.round(chromeHeight + contentEl.scrollHeight),
      ))
    }
    if (target === panel.floating.height) return

    // The transition is set on the DOM node directly rather than through React
    // style props so it stays out of PanelFrame's render path and can't leak
    // into an interactive drag. Flush it to the browser BEFORE changing the
    // height — both land in one style recalc otherwise, and the transition can
    // be dropped because the before-change style had none.
    frameEl.style.transition = `height ${TAB_ANIM_RESIZE_MS}ms ${TAB_ANIM_EASE}`
    void frameEl.offsetHeight
    clearTimeout(resizeAnimTimerRef.current)
    resizeAnimTimerRef.current = setTimeout(() => { frameEl.style.transition = '' }, TAB_ANIM_RESIZE_MS + 30)

    registry.resizeFloatingPanel('sampler', panel.floating.x, panel.floating.y, panel.floating.width, target)
  }, [tab])

  useEffect(() => () => clearTimeout(resizeAnimTimerRef.current), [])

  // ── Sample slots ──────────────────────────────────────────────────────────
  // `slots` mirrors the engine's slot list. Mini-control drags mutate it
  // LOCALLY for preview; the commit on mouseup is the only thing that reaches
  // IPC. `selectedSlot` is what the Sample tab's waveform/trim/loop editor and
  // the root-note picker bind to.
  const [slots, setSlots] = useState([{}])
  const [selectedSlot, setSelectedSlot] = useState(0)
  const [slotBusy, setSlotBusy] = useState(false)
  const selectedSlotRef = useRef(0)
  selectedSlotRef.current = selectedSlot
  const slotsRef = useRef(slots)
  slotsRef.current = slots

  const fetchAll = useCallback(async () => {
    try {
      const slotIdx = selectedSlotRef.current
      const [regions, ai] = await Promise.all([
        window.xleth?.timeline?.getRegions?.(),
        window.xleth?.timeline?.getRegionAudioInfo?.(regionId, slotIdx),
      ])
      const r = Array.isArray(regions) ? regions.find((x) => x.id === regionId) : null
      if (r) {
        setRegion(r)
        // Slot list, clamped to the engine's ceiling. The engine guarantees at
        // least one slot; the fallback keeps the UI alive if that ever fails.
        const rawSlots = Array.isArray(r.slots) && r.slots.length ? r.slots : [{}]
        const nextSlots = rawSlots.slice(0, MAX_SLOTS)
        setSlots(nextSlots)
        // A removed slot can leave the selection past the end.
        const sel = Math.min(slotIdx, nextSlots.length - 1)
        if (sel !== slotIdx) setSelectedSlot(sel)
        // Per-slot fields come from the SELECTED slot, so the Sample tab's
        // waveform / trim / loop editor edits that layer.
        const sl = nextSlots[sel] || {}
        setSettings({
          rootNote: sl.rootNote ?? 60,
          loopEnabled: !!sl.loopEnabled,
          loopStart: sl.loopStart ?? 0,
          loopEnd: sl.loopEnd ?? 0,
          loopMode: sl.loopMode ?? 0,
          exitLoopOnRelease: !!sl.exitLoopOnRelease,
          // MANGLE is per-slot, so its chain follows the selected layer like
          // trim and loop do. Copied instance-by-instance so panel edits never
          // mutate the fetched slot object in place.
          mangleChain: Array.isArray(sl.mangleChain)
            ? sl.mangleChain.map((mi) => ({
                mode: mi.mode ?? 0,
                amount: mi.amount ?? 0,
                mix: mi.mix ?? 1,
                bypass: !!mi.bypass,
              }))
            : [],
          prepAlgorithm: sl.prepAlgorithm ?? 2,
          prepStretch: sl.prepStretch ?? 1,
          prepShiftCents: sl.prepShiftCents ?? 0,
          crossfadeEnabled: r.crossfadeEnabled ?? true,
          smpStart: sl.smpStart ?? 0,
          smpLength: sl.smpLength ?? 0,
          declickMs: sl.declickMs ?? 1.5,
          fadeInMs: sl.fadeInMs ?? 0,
          fadeOutMs: sl.fadeOutMs ?? 0,
          crossfadeSamples: sl.crossfadeSamples ?? 5000,
          dcOffsetRemoved: !!sl.dcOffsetRemoved,
          normalized: !!sl.normalized,
          polarityReversed: !!sl.polarityReversed,
          reversed: !!sl.reversed,
          monoEnabled: !!r.monoEnabled,
          portamentoEnabled: !!r.portamentoEnabled,
          portamentoTimeMs: r.portamentoTimeMs ?? 100,
          voiceCount: clampVoiceCount(r.voiceCount ?? 32),
          legatoEnabled: !!r.legatoEnabled,
          portamentoMode: r.portamentoMode ?? 0,
          portamentoCurve: r.portamentoCurve ?? 0,
          arpEnabled: !!r.arpEnabled,
          arpTempoSync: r.arpTempoSync !== false,
          arpDivision: r.arpDivision ?? 8,
          arpFreeTimeMs: r.arpFreeTimeMs ?? 125,
          arpGate: r.arpGate ?? 0.8,
          arpRange: r.arpRange ?? 1,
          arpDirection: r.arpDirection ?? 0,
        })
      }
      if (ai) setAudioInfo(ai)
    } catch (e) {
      console.warn('[SamplerPanelContent] fetch failed:', e.message)
    }
  }, [regionId, selectedSlot])

  useEffect(() => {
    fetchAll()
    const onChanged = (e) => {
      if (e.detail?.regionId && e.detail.regionId !== regionId) return
      fetchAll()
    }
    timelineEvents.addEventListener('timeline-sampler-changed', onChanged)
    return () => timelineEvents.removeEventListener('timeline-sampler-changed', onChanged)
  }, [fetchAll, regionId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Project tempo for the modulation rack's BPM read-outs. Refresh on the same
  // event the transport dispatches so a tempo change is reflected live.
  useEffect(() => {
    let cancelled = false
    const readBpm = async () => {
      try {
        const v = await window.xleth?.timeline?.getBPM?.()
        if (!cancelled && typeof v === 'number' && v > 0) setBpm(v)
      } catch { /* keep the default */ }
    }
    readBpm()
    const onBpm = () => readBpm()
    timelineEvents.addEventListener('timeline-bpm-changed', onBpm)
    return () => { cancelled = true; timelineEvents.removeEventListener('timeline-bpm-changed', onBpm) }
  }, [])

  useEffect(() => {
    if (regionId == null) return
    const KEY_MAP = {
      KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64,
      KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69, KeyJ: 70, KeyM: 71,
      KeyQ: 72, Digit2: 73, KeyW: 74, Digit3: 75, KeyE: 76,
      KeyR: 77, Digit5: 78, KeyT: 79, Digit6: 80, KeyY: 81, Digit7: 82, KeyU: 83,
      KeyI: 84, Digit9: 85, KeyO: 86, Digit0: 87, KeyP: 88,
    }
    const held = new Set()
    const isTyping = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const onDown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping()) return
      const note = KEY_MAP[e.code]
      if (note == null || held.has(note)) return
      held.add(note)
      e.preventDefault()
      window.xleth?.timeline?.previewNote?.(regionId, note, 0.8)
    }
    const onUp = (e) => {
      const note = KEY_MAP[e.code]
      if (note == null || !held.has(note)) return
      held.delete(note)
      window.xleth?.timeline?.previewNoteOff?.(regionId, note)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      for (const note of held) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, note)
      }
    }
  }, [regionId])

  // AUTO-loop telemetry: remember the last apply so an edit to loopStart/loopEnd/
  // crossfade within 30 s of it is logged as a "nudge" (the only signal for how
  // often the snap is kept vs. adjusted — there is no confidence model).
  const lastAutoApplyRef = useRef(null)

  const maybeLogNudge = useCallback((partial) => {
    const event = nudgeEventFor(lastAutoApplyRef.current, partial, regionId)
    if (!event) return
    window.xleth?.loopTelemetry?.append?.(event)
    lastAutoApplyRef.current = null  // one nudge per apply
  }, [regionId])

  const commit = useCallback(async (partial) => {
    if (regionId == null) return
    maybeLogNudge(partial)
    try {
      // slotIndex routes the flat per-sample keys (trim / loop / fades / root
      // note / destructive flags) onto the selected layer. Sampler-level keys
      // in the same payload ignore it.
      await window.xleth?.timeline?.updateSamplerSettings(regionId,
        { ...partial, slotIndex: selectedSlotRef.current })
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: {} }))
    } catch (e) { console.warn('[SamplerPanelContent] updateSamplerSettings failed:', e.message) }
  }, [regionId, maybeLogNudge])

  // ── Slot handlers ─────────────────────────────────────────────────────────
  // Mini-drag preview: LOCAL state only. No IPC while the pointer is down.
  const previewSlotField = useCallback((slotIdx, field, value) => {
    setSlots((prev) => prev.map((sl, i) => (i === slotIdx ? { ...sl, [field]: value } : sl)))
  }, [])

  // Single commit on mouseup. Sends the whole slot list so the engine's
  // undo command captures one coherent before/after pair.
  const commitSlotField = useCallback(async (slotIdx, field, value) => {
    if (regionId == null) return
    const next = slotsRef.current.map((sl, i) => (i === slotIdx ? { ...sl, [field]: value } : sl))
    setSlots(next)
    try {
      await window.xleth?.timeline?.updateSamplerSettings(regionId, { slots: next })
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
    } catch (e) {
      console.warn('[SamplerPanelContent] slot commit failed:', e.message)
    }
  }, [regionId])

  const toggleSlotFlag = useCallback((slotIdx, flag) => {
    const cur = slotsRef.current[slotIdx]
    if (!cur) return
    commitSlotField(slotIdx, flag, !cur[flag])
  }, [commitSlotField])

  // Pick an audio file. Reuses the app's established audio picker (the same
  // one region swap uses), so slot loading accepts the same WAV input and
  // defaults to the project's exports/ dir. Returns a path or null.
  const pickAudioFile = useCallback(async () => {
    const res = await window.xleth?.audio?.openSwapAudioDialog?.()
    return typeof res === 'string' && res ? res : null
  }, [])

  const addSlot = useCallback(async () => {
    if (regionId == null || slotsRef.current.length >= MAX_SLOTS) return
    const filePath = await pickAudioFile()
    if (!filePath) return
    setSlotBusy(true)
    try {
      const r = await window.xleth?.timeline?.addSampleSlot?.(regionId, filePath)
      if (r && r.success === false) {
        console.warn('[SamplerPanelContent] addSampleSlot failed:', r.error)
      } else if (r && typeof r.slotIndex === 'number') {
        setSelectedSlot(r.slotIndex)
      }
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
    } catch (e) {
      console.warn('[SamplerPanelContent] addSampleSlot threw:', e.message)
    } finally {
      setSlotBusy(false)
      fetchAll()
    }
  }, [regionId, pickAudioFile, fetchAll])

  const swapSlot = useCallback(async (slotIdx) => {
    if (regionId == null) return
    const filePath = await pickAudioFile()
    if (!filePath) return
    setSlotBusy(true)
    try {
      // Slot 1 IS the region's audio — swapping it leaves its settings and
      // every other slot untouched, which is exactly what swapRegionAudio does.
      const r = slotIdx === 0
        ? await window.xleth?.audio?.swapRegionAudio?.(regionId, filePath)
        : await window.xleth?.timeline?.setSlotAudio?.(regionId, slotIdx, filePath)
      if (r && r.success === false) {
        console.warn('[SamplerPanelContent] slot swap failed:', r.error)
      }
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
    } catch (e) {
      console.warn('[SamplerPanelContent] slot swap threw:', e.message)
    } finally {
      setSlotBusy(false)
      fetchAll()
    }
  }, [regionId, pickAudioFile, fetchAll])

  const duplicateSlot = useCallback(async (slotIdx) => {
    if (regionId == null || slotsRef.current.length >= MAX_SLOTS) return
    setSlotBusy(true)
    try {
      const r = await window.xleth?.timeline?.duplicateSampleSlot?.(regionId, slotIdx)
      if (r && r.success === false) {
        console.warn('[SamplerPanelContent] duplicateSampleSlot failed:', r.error)
      } else if (r && typeof r.slotIndex === 'number') {
        setSelectedSlot(r.slotIndex)
      }
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
    } catch (e) {
      console.warn('[SamplerPanelContent] duplicateSampleSlot threw:', e.message)
    } finally {
      setSlotBusy(false)
      fetchAll()
    }
  }, [regionId, fetchAll])

  const removeSlot = useCallback(async (slotIdx) => {
    if (regionId == null || slotIdx <= 0) return
    setSlotBusy(true)
    try {
      const r = await window.xleth?.timeline?.removeSampleSlot?.(regionId, slotIdx)
      if (r && r.success === false) {
        console.warn('[SamplerPanelContent] removeSampleSlot failed:', r.error)
      }
      setSelectedSlot((cur) => (cur >= slotIdx ? Math.max(0, cur - 1) : cur))
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
    } catch (e) {
      console.warn('[SamplerPanelContent] removeSampleSlot threw:', e.message)
    } finally {
      setSlotBusy(false)
      fetchAll()
    }
  }, [regionId, fetchAll])

  const setField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
  }, [])
  const setFields = useCallback((partial) => {
    setSettings((s) => ({ ...s, ...partial }))
  }, [])

  const commitField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
    commit({ [field]: val })
  }, [commit])

  // ── MANGLE chain editing ──────────────────────────────────────────────────
  // The whole ordered array is the unit of truth: every add / remove / reorder /
  // field edit rebuilds it and commits the FULL array under one slotIndex, so
  // the engine's undo captures one coherent before/after and the audio thread
  // gets exactly one atomic chain swap. The panel always shows at least one row;
  // an empty committed chain renders a virtual Off instance that materialises
  // the moment the user gives it a mode.
  const mangleBaseChain = useCallback(() => {
    const c = settingsRef.current.mangleChain
    return Array.isArray(c) && c.length
      ? c
      : [{ mode: MANGLE_OFF, amount: 0, mix: 1, bypass: false }]
  }, [])
  const commitChain = useCallback((chain) => {
    const next = chain.slice(0, MANGLE_MAX)
    setSettings((s) => ({ ...s, mangleChain: next }))
    commit({ mangleChain: next })
  }, [commit])
  // Local-only preview during a knob drag — no IPC until mouseup.
  const previewChainField = useCallback((idx, field, val) => {
    setSettings((s) => {
      const base = (Array.isArray(s.mangleChain) && s.mangleChain.length)
        ? s.mangleChain
        : [{ mode: MANGLE_OFF, amount: 0, mix: 1, bypass: false }]
      return { ...s, mangleChain: base.map((mi, i) => (i === idx ? { ...mi, [field]: val } : mi)) }
    })
  }, [])
  const commitChainField = useCallback((idx, field, val) => {
    commitChain(mangleBaseChain().map((mi, i) => (i === idx ? { ...mi, [field]: val } : mi)))
  }, [commitChain, mangleBaseChain])
  const addMangleInstance = useCallback(() => {
    const base = mangleBaseChain()
    if (base.length >= MANGLE_MAX) return
    commitChain([...base, { mode: MANGLE_OFF, amount: 0, mix: 1, bypass: false }])
  }, [commitChain, mangleBaseChain])
  // A route to a MANGLE knob is addressed by chain POSITION (target + slot +
  // stage), so an edit that moves the instances has to move their routes too —
  // otherwise a reorder hands one instance's modulators to whichever mode took
  // its place. Read imperatively: the panel does not otherwise subscribe to the
  // modulation store and has no reason to re-render when a route changes.
  const remapMangleRoutes = useCallback((mapStage) => {
    useSamplerModulationStore.getState().remapMangleStages(selectedSlotRef.current, mapStage)
  }, [])
  const removeMangleInstance = useCallback((idx) => {
    commitChain(mangleBaseChain().filter((_, i) => i !== idx))
    // The instance is gone, so its routes go with it; everything after it
    // shuffles one position earlier.
    remapMangleRoutes((s) => (s === idx ? -1 : (s > idx ? s - 1 : s)))
  }, [commitChain, mangleBaseChain, remapMangleRoutes])
  const moveMangleInstance = useCallback((idx, dir) => {
    const base = mangleBaseChain().slice()
    const j = idx + dir
    if (j < 0 || j >= base.length) return
    ;[base[idx], base[j]] = [base[j], base[idx]]
    commitChain(base)
    remapMangleRoutes((s) => (s === idx ? j : (s === j ? idx : s)))
  }, [commitChain, mangleBaseChain, remapMangleRoutes])

  const commitLoopPoints = useCallback(({ loopStart, loopEnd }) => {
    setFields({ loopStart, loopEnd })
    commit({ loopStart, loopEnd })
  }, [commit, setFields])

  const commitSmpPoints = useCallback(({ smpStart, smpLength }) => {
    setFields({ smpStart, smpLength })
    commit({ smpStart, smpLength })
  }, [commit, setFields])

  // ── PREP bake watch ───────────────────────────────────────────────────────
  // A PREP commit queues an offline bake in the engine. getSlotBakeStatus is
  // both the status read AND the engine's main-thread pump for publishing a
  // finished bake into the live samplers, so we poll it while a bake could be
  // outstanding. `changed` means a baked buffer was just swapped in — the
  // waveform and the sample length both move, so refetch.
  //
  // The watch is armed by a commit (not by the poll finding work), because a
  // job takes a moment to register: polling only while `pending` is non-empty
  // would stop before the first job appeared.
  const [prepBusy, setPrepBusy] = useState(false)
  const [prepWatch, setPrepWatch] = useState(0)

  useEffect(() => {
    if (regionId == null || prepWatch === 0) return
    let cancelled = false
    let idleRounds = 0
    const timer = setInterval(async () => {
      if (cancelled) return
      try {
        const st = await window.xleth?.timeline?.getSlotBakeStatus?.(regionId)
        if (cancelled) return
        const pending = Array.isArray(st?.pending) ? st.pending.length : 0
        setPrepBusy(pending > 0)
        if (st?.changed) fetchAll()
        // Two consecutive empty polls means the queue really is drained, not
        // that we looked before the job registered.
        idleRounds = pending > 0 ? 0 : idleRounds + 1
        if (idleRounds >= 2) { cancelled = true; clearInterval(timer); setPrepBusy(false) }
      } catch (e) {
        cancelled = true
        clearInterval(timer)
        setPrepBusy(false)
        console.warn('[SamplerPanelContent] getSlotBakeStatus failed:', e?.message)
      }
    }, 250)
    return () => { cancelled = true; clearInterval(timer) }
  }, [regionId, prepWatch, fetchAll])

  // Commit a PREP parameter and arm the bake watch. Separate from commitField
  // so only the three parameters that trigger a bake pay for the polling.
  const commitPrep = useCallback((partial) => {
    setFields(partial)
    commit(partial)
    setPrepBusy(true)
    setPrepWatch((n) => n + 1)
  }, [commit, setFields])

  const [autoBusy, setAutoBusy] = useState(false)

  // AUTO loop: snap a period-aligned, formant-stable loop inside the current
  // trim selection (whole sample if untrimmed). The engine writes the loop
  // undoably and returns it; we mirror it into local state, log telemetry, and
  // fire an instant audible preview through the existing preview-note path.
  const runAutoLoop = useCallback(async () => {
    if (regionId == null || autoBusy) return
    const s = settingsRef.current
    const total = audioInfo?.numSamples || 0
    const hasTrim = (s.smpLength || 0) > 0
    const selStart = hasTrim ? (s.smpStart || 0) : 0
    const selEnd = hasTrim ? (s.smpStart || 0) + s.smpLength : total
    setAutoBusy(true)
    try {
      // AUTO must analyse AND write the SELECTED slot. Without the 4th arg the
      // engine defaults to slot 0, so hitting AUTO on any layer silently
      // re-looped the region's own sample instead.
      const res = await window.xleth?.timeline?.autoLoopForSelection?.(
        regionId, selStart, selEnd, selectedSlotRef.current)
      if (!res || !res.valid) {
        console.warn('[AUTO] no loop found:', res?.reason || 'unavailable')
        return
      }
      // The engine already wrote + rebuilt the samplers; mirror into local state.
      setFields({
        loopEnabled: true, crossfadeEnabled: true,
        loopStart: res.loopStart, loopEnd: res.loopEnd, crossfadeSamples: res.crossfadeSamples,
      })
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: {} }))

      // Arm nudge detection + log the apply.
      lastAutoApplyRef.current = applyRecordFor(res, regionId)
      window.xleth?.loopTelemetry?.append?.({
        kind: 'apply',
        sample_duration: res.sampleDurationSec,
        gates_bound: res.gatesBound || [],
        loop: {
          loopStart: res.loopStart, loopEnd: res.loopEnd, crossfadeSamples: res.crossfadeSamples,
          period: res.period, periodMultiple: res.periodMultiple,
        },
      })

      // Instant audible preview: hold the root note (loops while sounding), then
      // release after a short burst so the seam cycles a few times.
      const note = s.rootNote ?? 60
      window.xleth?.timeline?.previewNote?.(regionId, note, 0.8)
      setTimeout(() => window.xleth?.timeline?.previewNoteOff?.(regionId, note), 2500)
    } catch (e) {
      console.warn('[AUTO] autoLoopForSelection failed:', e?.message)
    } finally {
      setAutoBusy(false)
    }
  }, [regionId, autoBusy, audioInfo, setFields])

  const numSamples = audioInfo?.numSamples || 0
  const sampleRate = audioInfo?.originalSampleRate || 48000
  // Flat parity: generic (non-modulation) knobs follow the app's flat teal
  // accent, matching the rest of the flat chrome. Per-modulation env/LFO knobs
  // keep their distinct color-coding via envColor below.
  const accentPanel = tokenValue('--xleth-flat-accent') || tokenValue('--theme-panel-mixer')
  const muted = 'var(--theme-text-muted)'
  const text = 'var(--theme-text)'
  const card = 'var(--theme-bg-elevated)'
  const border = 'var(--theme-border-subtle)'
  const lblStyle = { fontSize: 9, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em' }
  const sourceName = (audioInfo?.audioFilePath || '').split(/[\\/]/).pop() || ''
  const sourceDuration = audioInfo?.duration ?? (sampleRate > 0 ? numSamples / sampleRate : 0)

  const prepBypassed = prepIsBypassed(settings)
  // The chain as edited, always ≥1 row: an empty committed chain shows one
  // virtual Off instance that materialises the moment it is given a mode.
  const mangleChain = (Array.isArray(settings.mangleChain) && settings.mangleChain.length)
    ? settings.mangleChain
    : [{ mode: MANGLE_OFF, amount: 0, mix: 1, bypass: false }]
  // An instance runs only when it has a real mode, is not bypassed, and mixes
  // in — the same gate MangleDsp.h makeRuntime applies. The card carries the
  // accent when ANY instance in the chain is live.
  const mangleInstanceActive = (mi) =>
    (mi?.mode ?? 0) !== MANGLE_OFF && !mi?.bypass && (mi?.mix ?? 1) > 0
  const mangleOn = mangleChain.some(mangleInstanceActive)

  const renderSample = () => (
    <div className="sampler-page sampler-page--sample">
      <SlotList
        slots={slots}
        selectedSlot={selectedSlot}
        onSelectSlot={setSelectedSlot}
        onPreviewSlotField={previewSlotField}
        onCommitSlotField={commitSlotField}
        onToggleMute={(i) => toggleSlotFlag(i, 'mute')}
        onToggleSolo={(i) => toggleSlotFlag(i, 'solo')}
        onAddSlot={addSlot}
        onSwapSlot={swapSlot}
        onDuplicateSlot={duplicateSlot}
        onRemoveSlot={removeSlot}
        busy={slotBusy}
      />
      <section className="sampler-waveform-block">
        <div className="sampler-waveform-meta">
          <span className="sampler-waveform-name" title={sourceName}>{sourceName}</span>
          <span>{(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)}kHz &middot; {formatDuration(sourceDuration)}</span>
        </div>
        <div className="sampler-waveform-well">
          <SamplerWaveform
          regionId={regionId}
          slotIndex={selectedSlot}
          numSamples={numSamples}
          loopEnabled={settings.loopEnabled}
          loopStart={settings.loopStart}
          loopEnd={settings.loopEnd || numSamples}
          onCommitLoopPoints={commitLoopPoints}
          smpStart={settings.smpStart}
          smpLength={settings.smpLength}
          declickMs={settings.declickMs}
          fadeInMs={settings.fadeInMs}
          fadeOutMs={settings.fadeOutMs}
          crossfadeSamples={settings.crossfadeSamples}
          sampleRate={sampleRate}
          onCommitSmpPoints={commitSmpPoints}
            width={WAVE_WIDTH}
            height={WAVE_HEIGHT}
            responsive
          />
        </div>
      </section>

      {/* PREP sits between the raw file and everything below it: the bake it
          produces is the buffer trim, loop, fades and the waveform above all
          work against. Placed here so the panel reads in pipeline order. */}
      <section className={`sampler-range-card sampler-range-card--prep${prepBypassed ? ' is-bypassed' : ''}`}>
        <header>
          <i /><span>Prep</span>
          {prepBusy && <span className="sampler-prep-busy">baking…</span>}
          <button
            type="button"
            onClick={() => commitPrep({ prepStretch: 1, prepShiftCents: 0 })}
            disabled={prepBypassed}
            title="Return to unity stretch and zero shift — the slot plays its raw sample with no bake"
          >
            Reset
          </button>
        </header>
        <div className="sampler-prep-body">
          <label className="sampler-prep-algo">
            <span>Algorithm</span>
            <SelKV
              val={settings.prepAlgorithm}
              set={(v) => commitPrep({ prepAlgorithm: v })}
              opts={PREP_ALGOS}
            />
          </label>
          <SamplerKnob
            label="Stretch"
            value={settings.prepStretch * 100}
            min={25} max={400} defaultValue={100}
            size={42}
            color={accentPanel}
            formatValue={(v) => `${Math.round(v)}%`}
            onLiveChange={(v) => setField('prepStretch', Math.round(v) / 100)}
            onCommit={(v) => commitPrep({ prepStretch: Math.round(v) / 100 })}
          />
          <SamplerKnob
            label="Shift"
            value={settings.prepShiftCents}
            min={-2400} max={2400} defaultValue={0}
            size={42}
            color={accentPanel}
            formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}c`}
            onLiveChange={(v) => setField('prepShiftCents', Math.round(v))}
            onCommit={(v) => commitPrep({ prepShiftCents: Math.round(v) })}
          />
          <span className="sampler-prep-note">
            {prepBypassed
              ? 'Bypassed — raw sample, no bake'
              : 'Baked once, off the audio thread'}
          </span>
        </div>
      </section>

      {/* PROCESS applies destructively to the baked buffer, so it reads directly
          under PREP and above the trim/loop stages that work on its output. */}
      <section className="sampler-card sampler-process-card">
        <SectionLabel>Process (applies immediately)</SectionLabel>
        <div className="sampler-process-row">
          <ProcessButton label="Remove DC Offset" active={!!settings.dcOffsetRemoved} onClick={() => commitField('dcOffsetRemoved', !settings.dcOffsetRemoved)}><span aria-hidden>-</span></ProcessButton>
          <ProcessButton label="Normalize" active={!!settings.normalized} onClick={() => commitField('normalized', !settings.normalized)}><span aria-hidden>~</span></ProcessButton>
          <ProcessButton label="Reverse Polarity" active={!!settings.polarityReversed} onClick={() => commitField('polarityReversed', !settings.polarityReversed)}><span aria-hidden>+/-</span></ProcessButton>
          <ProcessButton label="Reverse" active={!!settings.reversed} onClick={() => commitField('reversed', !settings.reversed)}><span aria-hidden>&lt;&gt;</span></ProcessButton>
        </div>
      </section>

      {/* Auditioning routes through a track's effect rack so the keyboard
          preview above sounds like the sample does in the arrangement. */}
      <section className="sampler-card sampler-preview-routing-card">
        <SectionLabel>Preview monitoring</SectionLabel>
        <PreviewRoutingControl regionId={regionId} />
      </section>

      <div className="sampler-identity-row">
        <section className="sampler-card sampler-mode-card">
          <SectionLabel>Mode</SectionLabel>
          <Seg
            opts={[{ v: false, l: 'One-shot' }, { v: true, l: 'Sustained' }]}
            val={!!settings.crossfadeEnabled}
            set={(value) => commitField('crossfadeEnabled', value)}
          />
        </section>

        <section className="sampler-range-card sampler-range-card--trim">
          <header><i /><span>Trim</span></header>
          <div className="sampler-range-knobs sampler-range-knobs--trim">
        <SamplerKnob
          label="SMP Start"
          value={settings.smpStart}
          min={0}
          max={Math.max(0, numSamples - 1)}
          defaultValue={0}
          size={42}
          color={accentPanel}
          onLiveChange={(v) => setField('smpStart', Math.round(v))}
          onCommit={(v) => commit({ smpStart: Math.round(v) })}
        />
        <SamplerKnob
          label="Length"
          value={settings.smpLength === 0 ? numSamples : settings.smpLength}
          min={0}
          max={numSamples}
          defaultValue={numSamples}
          size={42}
          color={accentPanel}
          formatValue={(v) => {
            const r = Math.round(v)
            return (numSamples === 0 || r >= numSamples) ? 'FULL' : String(r)
          }}
          onLiveChange={(v) => {
            const len = Math.round(v)
            setField('smpLength', len >= numSamples ? 0 : len)
          }}
          onCommit={(v) => {
            const len = Math.round(v)
            commit({ smpLength: len >= numSamples ? 0 : len })
          }}
        />
        <SamplerKnob
          label="In"
          value={settings.fadeInMs}
          min={0} max={5000} defaultValue={0}
          size={42}
          color={accentPanel}
          formatValue={(v) => `${Math.round(v)}ms`}
          onLiveChange={(v) => setField('fadeInMs', Math.round(v))}
          onCommit={(v) => commit({ fadeInMs: Math.round(v) })}
        />
        <SamplerKnob
          label="Out"
          value={settings.fadeOutMs}
          min={0} max={5000} defaultValue={0}
          size={42}
          color={accentPanel}
          formatValue={(v) => `${Math.round(v)}ms`}
          onLiveChange={(v) => setField('fadeOutMs', Math.round(v))}
          onCommit={(v) => commit({ fadeOutMs: Math.round(v) })}
        />
        <SamplerKnob
          label="Declick"
          value={settings.declickMs}
          min={0} max={10} step={0.1} defaultValue={1.5}
          size={42}
          color={accentPanel}
          formatValue={(v) => `${v.toFixed(1)}ms`}
          onLiveChange={(v) => setField('declickMs', Math.round(v * 10) / 10)}
          onCommit={(v) => commit({ declickMs: Math.round(v * 10) / 10 })}
        />
          </div>
        </section>

        <section className={`sampler-range-card sampler-range-card--loop${settings.loopEnabled ? '' : ' is-disabled'}`}>
          <header>
            <i /><span>Loop</span>
            <button
              type="button"
              className="sampler-auto-loop"
              onClick={runAutoLoop}
              disabled={autoBusy || numSamples === 0}
              title="Auto-loop: snap a period-aligned, formant-stable loop inside the trim selection (whole sample if untrimmed)"
            >
              {autoBusy ? '…' : 'AUTO'}
            </button>
            <button type="button" className={settings.loopEnabled ? 'is-active' : ''} onClick={() => commitField('loopEnabled', !settings.loopEnabled)}>
              {settings.loopEnabled ? 'On' : 'Off'}
            </button>
          </header>
          <div className="sampler-range-knobs sampler-range-knobs--loop">
        <SamplerKnob
          label="XFade"
          value={settings.crossfadeSamples}
          min={0} max={5000} defaultValue={0}
          size={36}
          color="var(--sampler-loop)"
          formatValue={(v) => `${Math.round(v)}`}
          onLiveChange={(v) => setField('crossfadeSamples', Math.round(v))}
          onCommit={(v) => commit({ crossfadeSamples: Math.round(v) })}
        />
        <SamplerKnob
          label="Loop Start"
          value={settings.loopStart}
          min={0}
          max={Math.max(0, numSamples - 1)}
          defaultValue={0}
          size={36}
          color="var(--sampler-loop)"
          onLiveChange={(v) => setField('loopStart', Math.round(v))}
          onCommit={(v) => commit({ loopStart: Math.round(v) })}
        />
        <SamplerKnob
          label="Loop End"
          value={settings.loopEnd === 0 ? numSamples : settings.loopEnd}
          min={0}
          max={numSamples}
          defaultValue={numSamples}
          size={36}
          color="var(--sampler-loop)"
          formatValue={(v) => {
            const r = Math.round(v)
            return (numSamples === 0 || r >= numSamples) ? 'END' : String(r)
          }}
          onLiveChange={(v) => {
            const end = Math.round(v)
            setField('loopEnd', end >= numSamples ? 0 : end)
          }}
          onCommit={(v) => {
            const end = Math.round(v)
            commit({ loopEnd: end >= numSamples ? 0 : end })
          }}
        />
          </div>
          <div className="sampler-loop-mode-row">
            <Seg
              sm
              opts={LOOP_MODES}
              val={settings.loopMode ?? 0}
              set={(v) => commitField('loopMode', v)}
            />
            <Chk
              val={settings.exitLoopOnRelease}
              set={(v) => commitField('exitLoopOnRelease', v)}
              label="Exit on release"
            />
          </div>
        </section>
      </div>

      {/* MANGLE sits last in the playback chain and is the only stage that is
          per NOTE rather than per slot-render: every sounding note gets its own
          effect instance before the voices sum. Placed after trim/loop because
          that is the order the audio actually travels. */}
      <section className={`sampler-range-card sampler-range-card--mangle${mangleOn ? '' : ' is-bypassed'}`}>
        <header>
          <i /><span>Mangle</span>
          {mangleOn && <span className="sampler-mangle-tag">per note</span>}
        </header>
        <div className="sampler-mangle-body">
          {/* One row per instance. The chain is an ordered stack — the output of
              instance N feeds N+1 — so reorder is audible. Each row: reorder /
              MODE / AMOUNT / MIX / bypass / remove; a "+" appends another. */}
          {mangleChain.map((inst, i) => {
            const instMode = inst.mode ?? 0
            const instActive = mangleInstanceActive(inst)
            const knobColor = instActive ? accentPanel : muted
            return (
              <div
                key={i}
                className={`sampler-mangle-inst${inst.bypass ? ' is-bypassed' : ''}${instActive ? ' is-active' : ''}`}
              >
                <div className="sampler-mangle-order">
                  <button
                    type="button" className="sampler-mangle-move"
                    disabled={i === 0} aria-label="Move earlier in the chain"
                    title="Move earlier in the chain"
                    onClick={() => moveMangleInstance(i, -1)}
                  >↑</button>
                  <button
                    type="button" className="sampler-mangle-move"
                    disabled={i === mangleChain.length - 1} aria-label="Move later in the chain"
                    title="Move later in the chain"
                    onClick={() => moveMangleInstance(i, 1)}
                  >↓</button>
                </div>
                <label className="sampler-prep-algo sampler-mangle-mode">
                  <span>Mode</span>
                  <SelGrouped
                    val={instMode}
                    set={(v) => commitChainField(i, 'mode', v)}
                    groups={MANGLE_GROUPS}
                    offLabel="Off"
                  />
                </label>
                <SamplerKnob
                  label="Amount"
                  modTarget={{ target: TARGET_SLOT_MANGLE_AMOUNT, index: selectedSlot, stage: i, scale: 0.01 }}
                  value={(inst.amount ?? 0) * 100}
                  min={0} max={100}
                  defaultValue={mangleAmountIsBipolar(instMode) ? 50 : 0}
                  size={42}
                  color={knobColor}
                  formatValue={(v) => `${Math.round(v)}%`}
                  onLiveChange={(v) => previewChainField(i, 'amount', Math.round(v) / 100)}
                  onCommit={(v) => commitChainField(i, 'amount', Math.round(v) / 100)}
                />
                <SamplerKnob
                  label="Mix"
                  modTarget={{ target: TARGET_SLOT_MANGLE_MIX, index: selectedSlot, stage: i, scale: 0.01 }}
                  value={(inst.mix ?? 1) * 100}
                  min={0} max={100} defaultValue={100}
                  size={42}
                  color={knobColor}
                  formatValue={(v) => `${Math.round(v)}%`}
                  onLiveChange={(v) => previewChainField(i, 'mix', Math.round(v) / 100)}
                  onCommit={(v) => commitChainField(i, 'mix', Math.round(v) / 100)}
                />
                <div className="sampler-mangle-inst-actions">
                  <button
                    type="button"
                    className={`sampler-mangle-bypass${inst.bypass ? '' : ' is-on'}`}
                    aria-pressed={!inst.bypass}
                    title={inst.bypass ? 'Bypassed — click to enable this instance'
                                       : 'Bypass this instance (skipped, at no cost)'}
                    onClick={() => commitChainField(i, 'bypass', !inst.bypass)}
                  >
                    {inst.bypass ? 'byp' : 'on'}
                  </button>
                  <button
                    type="button" className="sampler-mangle-remove"
                    aria-label="Remove this instance" title="Remove this instance"
                    onClick={() => removeMangleInstance(i)}
                  >×</button>
                </div>
              </div>
            )
          })}
          {mangleChain.length < MANGLE_MAX && (
            <button
              type="button" className="sampler-mangle-add"
              aria-label="Add another MANGLE to the chain"
              title="Add another MANGLE to the chain"
              onClick={addMangleInstance}
            >+</button>
          )}
          <span className="sampler-prep-note sampler-mangle-note">
            {(() => {
              const live = mangleChain.filter(mangleInstanceActive)
              if (live.length === 0) return 'Bypassed — stream passed through untouched'
              // One instance: show its specific hint. A chain: show the ordered
              // stack so the audible left-to-right signal flow is explicit.
              if (live.length === 1) {
                return MANGLE_HINTS[live[0].mode]
                  || `${mangleModeLabel(live[0].mode)} — Amount drives, Mix blends`
              }
              // Show the order the AUDIO travels, not the row order: warps
              // resolve first (they re-read the source, so they cannot be fed a
              // shaped sample), then the shapers. Order stays audible inside
              // each group, which is what the reorder arrows move.
              const warps   = live.filter((mi) => MANGLE_WARP_MODES.has(mi.mode))
              const shapers = live.filter((mi) => !MANGLE_WARP_MODES.has(mi.mode))
              const flow = [...warps, ...shapers].map((mi) => mangleModeLabel(mi.mode)).join(' → ')
              const note = (warps.length > 0 && shapers.length > 0)
                ? ' — per-note chain; warps resolve before shapers'
                : ' — per-note chain, order is audible'
              return `${flow}${note}`
            })()}
          </span>
        </div>
      </section>

    </div>
  )

  const renderPlayback = () => {
    const arpDirIdx = Math.max(0, Math.min(3, settings.arpDirection ?? 0))
    const arpDirId = ARP_DIRS[arpDirIdx]
    return (
      <div className="sampler-page sampler-page--playback">
        <div className="sampler-playback-grid sampler-voice-panel">
          {/* Root note lives on the playback tab (moved off the main tab): it
              picks the pitch a note plays the sample at, alongside voicing. */}
          <div className="sampler-module sampler-root-module">
            <SectionLabel>Root Note</SectionLabel>
            <RootNotePicker value={settings.rootNote} onChange={(midi) => commitField('rootNote', midi)} />
          </div>

          {/* Voice — poly count / mono / legato / portamento */}
          <div className="sampler-module sampler-voice-module">
            <SectionLabel>Voice</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
              <Seg
                opts={[{ v: 'mono', l: 'Mono' }, { v: 'poly', l: 'Poly' }]}
                val={settings.monoEnabled ? 'mono' : 'poly'}
                set={(v) => commitField('monoEnabled', v === 'mono')}
              />
              {/* POLY carries an editable voice count; MONO is a single voice. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...lblStyle,
                opacity: settings.monoEnabled ? 0.35 : 1,
                pointerEvents: settings.monoEnabled ? 'none' : undefined }}>
                Voices
                <input
                  type="number" min={1} max={32}
                  className="sampler-voice-count"
                  value={settings.voiceCount}
                  onChange={(e) => setField('voiceCount', clampVoiceCount(e.target.value))}
                  onBlur={(e) => commit({ voiceCount: clampVoiceCount(e.target.value) })}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <Chk val={settings.legatoEnabled} set={(v) => commitField('legatoEnabled', v)} label="Legato" />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 8, flexWrap: 'wrap', rowGap: 8 }}>
              <SamplerKnob
                value={settings.portamentoTimeMs}
                min={0} max={2000} defaultValue={0}
                size={44}
                color={settings.portamentoTimeMs > 0 ? accentPanel : 'var(--theme-text-muted)'}
                label="Porta"
                formatValue={(v) => `${Math.round(v)}ms`}
                onLiveChange={(v) => {
                  const ms = Math.round(v)
                  setFields({ portamentoTimeMs: ms, portamentoEnabled: ms > 0 })
                }}
                onCommit={(v) => {
                  const ms = Math.round(v)
                  commit({ portamentoTimeMs: ms, portamentoEnabled: ms > 0 })
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={lblStyle}>Glide</span>
                <Seg
                  sm
                  opts={[{ v: 0, l: 'Always' }, { v: 1, l: 'Scaled' }]}
                  val={settings.portamentoMode ?? 0}
                  set={(v) => commitField('portamentoMode', v)}
                />
              </div>
              <SamplerKnob
                label="Curve"
                value={settings.portamentoCurve ?? 0}
                min={-1} max={1} defaultValue={0}
                size={28} dragRange={120} capStyle="soft-disk"
                color="var(--theme-accent)"
                formatValue={(v) => v.toFixed(2)}
                onLiveChange={(v) => setField('portamentoCurve', Number(v.toFixed(3)))}
                onCommit={(v) => commit({ portamentoCurve: Number(v.toFixed(3)) })}
              />
            </div>
          </div>

          {/* Arpeggiator */}
          <div className="sampler-module sampler-arp-module">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: text, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Arpeggiator
              </span>
              <input
                type="checkbox"
                checked={settings.arpEnabled}
                onChange={(e) => commitField('arpEnabled', e.target.checked)}
                style={{ accentColor: 'var(--theme-accent)', cursor: 'pointer' }}
              />
            </div>
            <div className={settings.arpEnabled ? 'sampler-arp-controls' : 'sampler-arp-controls sampler-dimmed'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...lblStyle, width: 62 }}>Range</span>
                <Seg
                  sm
                  opts={[1, 2, 3, 4].map((n) => ({ v: n, l: `${n} Oct` }))}
                  val={settings.arpRange}
                  set={(v) => commitField('arpRange', v)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...lblStyle, width: 62 }}>Direction</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  {ARP_DIRS.map((id, idx) => {
                    const active = arpDirId === id
                    return (
                      <div
                        key={id}
                        onClick={() => commitField('arpDirection', idx)}
                        title={ARP_DIR_TITLES[id]}
                        style={{
                          width: 28, height: 26,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: active ? 'var(--theme-accent)' : card,
                          color: active ? 'var(--theme-text-on-accent)' : muted,
                          border: `1px solid ${active ? 'var(--theme-accent)' : border}`,
                          borderRadius: 3,
                          cursor: 'pointer',
                        }}
                      >
                        <svg width={14} height={15} viewBox="0 0 14 15">{ARP_DIR_ICONS[id]}</svg>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ ...lblStyle, width: 62 }}>Time</span>
                {settings.arpTempoSync ? (
                  <Sel
                    val={TDIV_LABELS[settings.arpDivision] || '1/8'}
                    set={(v) => commitField('arpDivision', TDIV_VALUES[v])}
                    opts={TDIVS}
                  />
                ) : (
                  <SamplerKnob
                    value={settings.arpFreeTimeMs}
                    min={10} max={2000} defaultValue={125}
                    size={28}
                    capStyle='soft-disk'
                    color={accentPanel}
                    formatValue={(v) => `${Math.round(v)}ms`}
                    onLiveChange={(v) => setField('arpFreeTimeMs', Math.round(v))}
                    onCommit={(v) => commit({ arpFreeTimeMs: Math.round(v) })}
                  />
                )}
                <Chk val={settings.arpTempoSync} set={(v) => commitField('arpTempoSync', v)} label="Tempo Sync" />
                <SamplerKnob
                  label="Gate"
                  value={settings.arpGate * 100}
                  min={1} max={100} defaultValue={80}
                  size={28}
                  capStyle='soft-disk'
                  color={accentPanel}
                  formatValue={(v) => `${Math.round(v)}%`}
                  onLiveChange={(v) => setField('arpGate', Math.round(v) / 100)}
                  onCommit={(v) => commit({ arpGate: Math.round(v) / 100 })}
                />
              </div>
            </div>
          </div>
        </div>
        {/* The legacy Envelope / Pitch-Envelope / Vol-Pan-Pitch LFO cards used to
            live here. They are gone — ENV 1 is the amp envelope and every other
            envelope/LFO is a modulation source in the pull-out tray. */}
      </div>
    )
  }

  return (
    <div className="sampler-panel-body">
      <div className="sampler-panel-tabbar">
        <div className="sampler-panel-tabs">
          <Tabs
            tabs={[{ id: 'main', label: 'main' }, { id: 'playback', label: 'playback' }]}
            active={tab}
            onSelect={handleSelectTab}
          />
        </div>
      </div>
      <div className="sampler-panel-scroll" ref={scrollRef}>
        <div
          className={`sampler-panel-content${
            tabAnimPhase === 'exiting' ? ` sampler-tab-pane--exit-${tab}`
              : tabAnimPhase === 'entering' ? ` sampler-tab-pane--enter-${tab}`
                : ''
          }`}
          ref={panelContentRef}
        >
          {tab === 'main' && renderSample()}
          {tab === 'playback' && renderPlayback()}
        </div>
      </div>
      {/* Modulation lives in a pull-out tray on the window's right edge instead
          of a tab, so an ENV/LFO sits beside the knobs it drives. */}
      <SamplerModTray regionId={regionId} bpm={bpm} />
    </div>
  )
}
