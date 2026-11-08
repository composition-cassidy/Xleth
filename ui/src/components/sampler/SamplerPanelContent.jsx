import { useEffect, useState, useCallback, useRef } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import { Tabs } from '../../ui-kit'
import SlotTabs, { MAX_SLOTS } from './SlotTabs.jsx'
import AuditionBar from './AuditionBar.jsx'
import PatchBar from './PatchBar.jsx'
import SamplerMainView from './SamplerMainView.jsx'
import LegacyPlaybackView from './LegacyPlaybackView.jsx'
import { noteForCode, clampOctaveShift } from './auditionKeymap.js'
import { copySlotSettings, buildSlotPaste, hasSlotClipboard } from './slotClipboard.js'
import {
  buildPatchState, saveSamplerPatch, loadSamplerPatch,
  mergePatchSlots, patchRegionSettings,
} from './samplerPatch.js'
import { MANGLE_OFF, MANGLE_MAX } from './mangleModes.js'
import SamplerModTray from './modulation/SamplerModTray.jsx'
import useSamplerModulationStore from '../../stores/samplerModulationStore.js'
import { nudgeEventFor, applyRecordFor, autoLoopSummary } from './autoLoopTelemetry.js'
import styles from './Sampler.module.css'

// ── Sampler ─────────────────────────────────────────────────────────────────
// The per-region sampler every pattern track's notes play through. One 28px
// header (slot tabs | patch | views), one body, one audition bar. The views
// share one height, so switching never resizes the panel and nothing animates.
//
// Data flow (unchanged): `slots` mirrors the engine's slot list; `settings` holds
// the SELECTED slot's per-sample fields plus the region-level fields. Every drag
// previews locally and commits once on release through updateSamplerSettings
// (one SetSamplerSettingsCommand, one Ctrl+Z).

const VIEW_TABS = [
  { id: 'main', label: 'Main', hint: 'Waveform, trim, loop, amp envelope, pitch, prep and process for the selected slot' },
  { id: 'playback', label: 'Playback', hint: 'Voicing, glide, arpeggiator and per-note effects' },
]

// PREP is bypassed at unity stretch and zero shift: mirrors the engine's
// SampleSlot::prepIsBypassed(), which is what decides whether a bake runs.
const prepIsBypassed = (s) =>
  Math.abs((s.prepStretch ?? 1) - 1) < 1e-6 && Math.abs(s.prepShiftCents ?? 0) < 1e-6

// Voice count is clamped to the engine's [1, 32] polyphony window.
const clampVoiceCount = (v) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 32
  return Math.max(1, Math.min(32, n))
}

// The amp/pitch envelopes and three drawable LFOs are gone: ENV 1 is the amp
// envelope and every other envelope/LFO is a modulation source.
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

export default function SamplerPanelContent({ regionId, onClose }) {
  const [tab, setTab] = useState('main')
  const [, setRegion] = useState(null)
  const [audioInfo, setAudioInfo] = useState(null)
  // Project tempo: the modulation editors show BPM-synced times with it.
  const [bpm, setBpm] = useState(140)
  const [settings, setSettings] = useState(emptySettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Bumped by the slot menu's "Rename"; the selected tab opens its name field.
  const [renameSignal, setRenameSignal] = useState(0)

  // ── Sample slots ──────────────────────────────────────────────────────────
  // `slots` mirrors the engine's slot list. Mini-control drags mutate it
  // LOCALLY for preview; the commit on mouseup is the only thing that reaches
  // IPC. `selectedSlot` is what the Sample tab's waveform/trim/loop editor and
  // the root-note picker bind to.
  const [slots, setSlots] = useState([{}])
  const [selectedSlot, setSelectedSlot] = useState(0)
  const [slotBusy, setSlotBusy] = useState(false)

  // ── Audition state ────────────────────────────────────────────────────────
  // The computer-keyboard piano used to be a fixed C4..E6 window at a hard-coded
  // velocity of 0.8, with nothing on screen saying it existed. These three
  // pieces of state are what the AuditionBar shows and steers.
  const [octaveShift, setOctaveShift] = useState(0)
  const [velocity, setVelocity] = useState(0.8)
  const [heldCount, setHeldCount] = useState(0)
  const octaveShiftRef = useRef(0)
  octaveShiftRef.current = octaveShift
  const velocityRef = useRef(velocity)
  velocityRef.current = velocity

  // Zero-crossing snap for waveform handle drags, and the waveform's current
  // zoom window — the Loop/Trim knobs scope their range to it, which is what
  // makes them usable on a long sample.
  // The slot clipboard is module state (it has to survive a panel close), so
  // nothing re-renders when it changes — this counter is what re-enables the
  // paste button the moment something has been copied.
  const [clipboardTick, setClipboardTick] = useState(0)
  const [snapZero, setSnapZero] = useState(true)
  const [waveView, setWaveView] = useState({ start: 0, len: 0, api: null })
  const onWaveViewChange = useCallback((v) => {
    setWaveView((prev) => (
      prev.start === v.start && prev.len === v.len && prev.api === v.api ? prev : v
    ))
  }, [])

  // Per-slot sample lengths. Only the SELECTED slot's length arrives with
  // audioInfo, but pasting settings and saving a patch both need to rescale
  // sample-index fields against the length of the layer they land on, so the
  // lengths are cached as slots are visited and fetched on demand otherwise.
  const numSamplesBySlotRef = useRef({})
  const slotLengthFor = useCallback(async (idx) => {
    const cached = numSamplesBySlotRef.current[idx]
    if (cached != null) return cached
    try {
      const ai = await window.xleth?.timeline?.getRegionAudioInfo?.(regionId, idx)
      const n = ai?.numSamples || 0
      numSamplesBySlotRef.current[idx] = n
      return n
    } catch { return 0 }
  }, [regionId])
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
      if (ai) {
        setAudioInfo(ai)
        // Cache this layer's length so a later paste / patch load can rescale
        // sample-index fields against it without another round trip.
        numSamplesBySlotRef.current[slotIdx] = ai.numSamples || 0
      }
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
    // code -> the note that key STARTED, so a release still stops the right
    // note if the octave was shifted while it was held down.
    const held = new Map()
    const isTyping = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const onDown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping()) return
      if (held.has(e.code)) return
      const note = noteForCode(e.code, octaveShiftRef.current)
      if (note == null) return
      held.set(e.code, note)
      setHeldCount(held.size)
      e.preventDefault()
      window.xleth?.timeline?.previewNote?.(regionId, note, velocityRef.current)
    }
    const onUp = (e) => {
      const note = held.get(e.code)
      if (note == null) return
      held.delete(e.code)
      setHeldCount(held.size)
      window.xleth?.timeline?.previewNoteOff?.(regionId, note)
    }
    // A focus loss mid-hold (alt-tab, a dialog) never delivers the keyup, which
    // used to leave the note sounding forever.
    const onBlur = () => {
      for (const note of held.values()) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, note)
      }
      held.clear()
      setHeldCount(0)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      for (const note of held.values()) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, note)
      }
    }
  }, [regionId])

  // ── Playhead poll ─────────────────────────────────────────────────────────
  // The engine publishes each slot's read head once per audio block; this polls
  // it for the SELECTED slot while there is any reason to.
  //
  // Armed by a held note, but it keeps going after the last key is released
  // until the engine itself reports -1: a note does not stop at note-off, it
  // runs its amp release (and, with exit-on-release, a whole loop pass plus the
  // tail), and cutting the playhead at keyup would hide exactly the part of the
  // sample a loop edit is about.
  const [playPosition, setPlayPosition] = useState(null)
  const playTailRef = useRef(false)

  useEffect(() => {
    if (regionId == null) return undefined
    if (heldCount === 0 && !playTailRef.current) {
      setPlayPosition(null)
      return undefined
    }
    let cancelled = false
    // ~30Hz. Finer than this is wasted: the value only changes once per audio
    // block, and each poll is a full IPC round trip.
    const timer = setInterval(async () => {
      if (cancelled) return
      try {
        const res = await window.xleth?.timeline?.getSamplerPlayPositions?.(regionId)
        if (cancelled) return
        const positions = Array.isArray(res?.positions) ? res.positions : []
        const p = positions[selectedSlotRef.current]
        const sounding = typeof p === 'number' && p >= 0
        playTailRef.current = sounding
        setPlayPosition(sounding ? p : null)
        // Nothing sounding and no key down — stop until the next note.
        if (!sounding && heldCount === 0) {
          cancelled = true
          clearInterval(timer)
        }
      } catch {
        cancelled = true
        clearInterval(timer)
        playTailRef.current = false
        setPlayPosition(null)
      }
    }, 33)
    return () => { cancelled = true; clearInterval(timer) }
  }, [regionId, heldCount])

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

  // `presetPath` short-circuits the picker: an OS file drop already knows the
  // path, and opening a dialog after a drop would be absurd.
  const addSlot = useCallback(async (presetPath = null) => {
    if (regionId == null || slotsRef.current.length >= MAX_SLOTS) return
    const filePath = presetPath || await pickAudioFile()
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

  const swapSlot = useCallback(async (slotIdx, presetPath = null) => {
    if (regionId == null) return
    const filePath = presetPath || await pickAudioFile()
    if (!filePath) return
    // The layer's audio is changing, so its cached length is stale — a paste or
    // a patch load rescaling against it would use the OLD sample's length.
    delete numSamplesBySlotRef.current[slotIdx]
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

  // One-shot audition of the root note, at the bar's current velocity. The
  // release is scheduled rather than held: this is a click, not a key, so there
  // is no keyup to hang the note off.
  const previewRootNoteTimer = useRef(null)
  const previewRootNote = useCallback(() => {
    if (regionId == null) return
    const note = settingsRef.current.rootNote ?? 60
    clearTimeout(previewRootNoteTimer.current)
    window.xleth?.timeline?.previewNote?.(regionId, note, velocityRef.current)
    previewRootNoteTimer.current = setTimeout(() => {
      window.xleth?.timeline?.previewNoteOff?.(regionId, note)
    }, 1200)
  }, [regionId])

  useEffect(() => () => clearTimeout(previewRootNoteTimer.current), [])

  const setField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
  }, [])
  const setFields = useCallback((partial) => {
    setSettings((s) => ({ ...s, ...partial }))
  }, [])

  // ── Slot name / clipboard ─────────────────────────────────────────────────
  // `name` is a real SampleSlot field that already round-trips through the
  // project JSON, so a rename is an ordinary slot commit — no engine change.
  // Empty clears the override and falls back to the filename.
  const renameSlot = useCallback((slotIdx, name) => {
    commitSlotField(slotIdx, 'name', name)
  }, [commitSlotField])

  const copySlot = useCallback(async () => {
    const idx = selectedSlotRef.current
    const slot = slotsRef.current[idx]
    if (!slot) return
    // Merge the panel's live per-slot settings over the fetched slot: trim,
    // loop, fades, prep and mangle live in `settings` for the SELECTED layer,
    // and those are exactly what is worth copying.
    const s = settingsRef.current
    copySlotSettings({ ...slot, ...s }, audioInfo?.numSamples || 0)
    setClipboardTick((n) => n + 1)
  }, [audioInfo])

  const pasteSlot = useCallback(async () => {
    const idx = selectedSlotRef.current
    const target = await slotLengthFor(idx)
    const patch = buildSlotPaste(target)
    if (!patch) return
    const { mangleChain, ...flat } = patch
    // One commit for the whole paste so it lands as a single undo step, the
    // same way every other multi-field sampler edit does.
    setFields({ ...flat, mangleChain })
    commit({ ...flat, mangleChain })
  }, [slotLengthFor, commit, setFields])

  // ── Patches ───────────────────────────────────────────────────────────────
  const savePatch = useCallback(async (name) => {
    // Every layer's length, so sample-index fields can be rescaled on load.
    const lengths = {}
    for (let i = 0; i < slotsRef.current.length; i++) lengths[i] = await slotLengthFor(i)
    // The selected layer's live edits are in `settings`, not yet in `slots`.
    const mergedSlots = slotsRef.current.map((sl, i) =>
      (i === selectedSlotRef.current ? { ...sl, ...settingsRef.current } : sl))
    let modulation = null
    try {
      modulation = await window.xleth?.timeline?.getSamplerModulation?.(regionId)
    } catch { /* a patch without modulation is still worth saving */ }
    return saveSamplerPatch({
      name,
      state: buildPatchState({
        settings: settingsRef.current,
        slots: mergedSlots,
        numSamplesBySlot: lengths,
        modulation,
      }),
    })
  }, [regionId, slotLengthFor])

  const loadPatch = useCallback(async (source, slug) => {
    const res = await loadSamplerPatch(source, slug)
    if (!res.ok) return res
    const lengths = {}
    for (let i = 0; i < slotsRef.current.length; i++) lengths[i] = await slotLengthFor(i)
    const nextSlots = mergePatchSlots(res.state.slots, slotsRef.current, lengths)
    try {
      // Slots, region-level settings AND the modulation config all go in ONE
      // call: Timeline_UpdateSamplerSettings accepts a `modulation` object in
      // the same payload precisely so a bulk caller does not need a second RPC,
      // and it routes everything through one SetSamplerSettingsCommand — so
      // loading a patch is a single Ctrl+Z, not one undo step per stage.
      await window.xleth?.timeline?.updateSamplerSettings?.(regionId, {
        slots: nextSlots,
        ...patchRegionSettings(res.state),
        ...(res.state.modulation ? { modulation: res.state.modulation } : null),
      })
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: {} }))
    } catch (e) {
      return { ok: false, error: e?.message || 'apply failed' }
    }
    await fetchAll()
    return { ok: true }
  }, [regionId, slotLengthFor, fetchAll])


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
  const [autoResult, setAutoResult] = useState(null)

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
        setAutoResult({ ok: false, text: `no loop found (${res?.reason || 'unavailable'})` })
        return
      }
      setAutoResult({ ok: true, text: autoLoopSummary(res) })
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
  const sourcePath = audioInfo?.audioFilePath || ''
  const sourceName = sourcePath.split(/[\\/]/).pop() || ''
  const sourceDuration = audioInfo?.duration ?? (sampleRate > 0 ? numSamples / sampleRate : 0)
  const prepBypassed = prepIsBypassed(settings)
  // `clipboardTick` is not read: it is the dependency that re-evaluates this
  // after a copy, because the clipboard itself is module state.
  const canPaste = hasSlotClipboard() || clipboardTick < 0

  // Sample-index knob travel: 180 px of drag moves exactly one visible window of
  // the waveform, so zooming in buys drag precision at the same rate it buys
  // visual precision.
  const waveViewLen = waveView.len > 0 ? waveView.len : numSamples
  const sampleDragRange = (numSamples > 0 && waveViewLen > 0)
    ? Math.round(180 * (numSamples / waveViewLen))
    : 180

  const mainActions = {
    setField, setFields, commit, commitField, commitPrep, commitLoopPoints, commitSmpPoints,
    previewSlotField, commitSlotField, toggleSlotFlag, runAutoLoop,
    slot: {
      swap: () => swapSlot(selectedSlot),
      duplicate: () => duplicateSlot(selectedSlot),
      copy: copySlot,
      paste: pasteSlot,
      rename: () => setRenameSignal((n) => n + 1),
      remove: () => removeSlot(selectedSlot),
    },
  }

  return (
    <div className={styles.root} data-sampler-view={tab}>
      <div className={styles.header}>
        <SlotTabs
          slots={slots}
          selectedSlot={selectedSlot}
          onSelectSlot={setSelectedSlot}
          onAddSlot={() => addSlot()}
          onAddSlotFromPath={(path) => addSlot(path)}
          onDropSlotAudio={(i, path) => swapSlot(i, path)}
          onRenameSlot={renameSlot}
          renameSignal={renameSignal}
          busy={slotBusy}
        />
        <PatchBar onSave={savePatch} onLoad={loadPatch} disabled={regionId == null} />
        <Tabs
          className={styles.views}
          label="Sampler views"
          tabs={VIEW_TABS}
          value={tab}
          onChange={setTab}
        />
      </div>

      <div className={styles.body}>
        {tab === 'main' && (
          <SamplerMainView
            regionId={regionId}
            slots={slots}
            slotIndex={selectedSlot}
            maxSlots={MAX_SLOTS}
            settings={settings}
            numSamples={numSamples}
            sampleRate={sampleRate}
            sourceName={sourceName}
            sourcePath={sourcePath}
            sourceDuration={sourceDuration}
            slotBusy={slotBusy}
            canPaste={canPaste}
            prepBusy={prepBusy}
            prepBypassed={prepBypassed}
            autoBusy={autoBusy}
            autoResult={autoResult}
            playPosition={playPosition}
            snapZero={snapZero}
            onSnapZero={setSnapZero}
            waveView={waveView}
            onWaveViewChange={onWaveViewChange}
            sampleDragRange={sampleDragRange}
            actions={mainActions}
          />
        )}
        {tab === 'playback' && (
          <div className={styles.scrollView}>
            <LegacyPlaybackView
              regionId={regionId}
              settings={settings}
              selectedSlot={selectedSlot}
              setField={setField}
              setFields={setFields}
              commit={commit}
              commitField={commitField}
              commitChainField={commitChainField}
              previewChainField={previewChainField}
              addMangleInstance={addMangleInstance}
              moveMangleInstance={moveMangleInstance}
              removeMangleInstance={removeMangleInstance}
            />
          </div>
        )}
      </div>

      {/* The audition keyboard applies to every view and is the panel's only
          "is this thing making a sound" affordance, so it is always shown. */}
      <AuditionBar
        octaveShift={octaveShift}
        onOctaveShift={(n) => setOctaveShift(clampOctaveShift(n))}
        velocity={velocity}
        onVelocity={setVelocity}
        heldCount={heldCount}
        rootNote={settings.rootNote ?? 60}
        onPreviewRoot={previewRootNote}
        disabled={regionId == null}
      />

      <SamplerModTray regionId={regionId} bpm={bpm} />
    </div>
  )
}
