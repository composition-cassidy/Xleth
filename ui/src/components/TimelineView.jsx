import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react'
import { pearlPlan } from '../ui-kit/pearlRules'
import TrackHeaderList from './timeline/TrackHeaderList.jsx'
import PatternListPanel from './timeline/PatternListPanel.jsx'
import TimelineCanvas from './timeline/TimelineCanvas.jsx'
import MacroAutomationLanes from './timeline/MacroAutomationLanes.jsx'
import { buildTrackLayout } from './timeline/timelineRowLayout.js'
import { buildReelModel } from './timeline/reelLaneModel.js'
import useReelLaneStore from '../stores/useReelLaneStore.js'
import { isClone } from '../clones/cloneModel.js'
import { addClone, moveClone } from '../clones/cloneApi.js'
import { cloneMenuItems, reelLanesKeyFor, trackRemovalSubject } from './timeline/cloneTimeline.js'
import MotionView, { motionKeyHostClassName } from './motionView/MotionView.jsx'
import { startMotionViewSession } from './motionView/motionViewSession.js'
import { useMotionData } from '../motion/useMotionData.js'
import { useMotionViewStore } from '../motion/motionViewStore.js'
import { useMotionRevealListener } from './motionView/useMotionReveal.js'
import { drawLengthForSnap, adoptDrawLength, resetDrawLength } from './timeline/drawLength.js'
import { tokenValue } from '../theming/tokenValue.ts'
import TimelineRuler from './timeline/TimelineRuler.jsx'
import LoopRegionBar, { loopRegionOverlayClassName } from './timeline/LoopRegionBar.jsx'
import SnapshotCueLane, { SnapshotCueLaneHeader, useSnapshotCues } from './timeline/SnapshotCueLane.jsx'
import TimelineScrollbar from './timeline/TimelineScrollbar.jsx'
import TimelineToolbar from './timeline/TimelineToolbar.jsx'
import Fader from './controls/Fader.jsx'
import { quantizedFromNorm } from '../utils/sliderHelpers.js'
import { pixelsToViewportPan } from './timeline/middleMousePan.js'
import { withSharedUndoGroup } from './timeline/undoGroup.js'
import ContextMenu from './ContextMenu.jsx'
import XlethSelect from './common/XlethSelect.jsx'
import TrackContextMenu from './timeline/TrackContextMenu.jsx'
import ConfirmConvertDialog from './timeline/ConfirmConvertDialog.jsx'
import QuantizeDialog from './timeline/QuantizeDialog.jsx'
import { buildQuantizeSpecs } from '../utils/quantize.js'
import useTimelineZoom from '../hooks/useTimelineZoom.js'
import useTimelineScroll from '../hooks/useTimelineScroll.js'
import useViewAnimator from '../hooks/useViewAnimator.js'
import { labelHexColor } from '../constants/labels.js'
import { normalizeTrackCustomColor, resolveAutoTrackColor, TRACK_PALETTE_FALLBACK } from './timeline/trackColorResolver.js'
import { subscribe } from '../transportStore.js'
import { startMacroAutomationPlayback } from '../fxgraph/macroAutomationPlayback.js'
import useEffectChainStore from '../stores/effectChainStore.js'
import { PLUGIN_NAMES } from './mixer/effectEditorOpeners.js'
import useAutoScrollStore from '../stores/autoScrollStore.js'
import { playheadClock } from '../services/PlayheadClock.js'
import { editCursor } from '../services/EditCursor.js'
import { createXlethStoppedPreviewSeekScheduler } from '../services/stoppedPreviewSeekScheduler.js'
import { timelineEvents } from '../timelineEvents.js'
import { toNewNoteCopy } from './pianoRoll/pianoRollEdits.js'
import { installNoteLensDevHook } from '../lensRoam/noteLensOverride.js'
import {
  BEATS_PER_BAR, DEFAULT_TRACK_HEIGHT, PPQ, RULER_HEIGHT, ADD_TRACK_ROW_HEIGHT,
  setTimelineTrackHeight, zoomTrackHeight,
  pixelToBeat, snapBeatToGrid, snapTickToGrid, beatsToTicks, ticksToBeats, regionDurationToTicks,
  GRANULARITY_BEATS, MAX_PPB, ZOOM_FACTOR,
} from '../constants/timeline.js'
import { currentRegime } from './timeline/waveformRegime.js'
import { reconcileById } from './timeline/listReconcile.js'
import { anchoredScrollX, scrollSpringWriteback } from './timeline/viewportAnchor.js'
import { contentEndBeats, fitBeatsFor, minPpbFor, maxScrollFor, wheelZoomSteps } from './timeline/zoomFit.js'
import { hiResCoversWindow } from './timeline/hiResCoverage.js'
import { findCoveringEntry, insertEntry } from './timeline/hiResRegionCache.js'
import { planRegionFetches } from './timeline/hiResFetchPlanner.js'
import {
  padClipWindow, prioritiseProcessedJobs, shouldRetryNotReady, pruneNotReady,
} from './timeline/hiResProcessedPlanner.js'
import { createHiResRedrawScheduler } from './timeline/hiResRedrawScheduler.js'
import { getRegionPlaybackDurationSec } from './timeline/regionDuration.js'
import { mergeClipModulationPatch } from './timeline/clipModulationPatch.js'
import { useClipVideoFxDefaultsStore } from '../stores/clipVideoFxDefaultsStore.js'
import { seedVideoFxDefaults } from './timeline/clipVideoFxApply.js'
import { VIBRATO_SYNC_DIVISIONS } from './timeline/clipVibrato.js'
import {
  SCRATCH_BABY_DEFAULT_COUNT,
  SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
  SCRATCH_BABY_LENGTHS,
  SCRATCH_DEFAULTS,
  SCRATCH_PRESETS,
  clampScratchCount,
  cloneScratchCurve,
  inferBabyScratchSettings,
  scratchPresetKeyForScratch,
  scratchPresetPatch,
} from './timeline/clipScratch.js'
import {
  closeAllClipFxEditors, reconcileClipFxEditors,
} from './timeline/clipFxEditorOpeners.js'
import { getClipRegionWaveformStartSec, resolveTimelinePalette } from './timeline/timelineDrawing.js'
import {
  buildTimelineClipboard,
  clipPayloadFromSnapshot,
  placementsEndTick,
  resolveOverwritePlan,
  resolveTimelinePaste,
} from './timeline/timelineClipboard.js'
import { planAutomationLoop } from './timeline/automationLoop.js'
import {
  flatTrackLayout,
  moveFolderInLayout,
  moveTracksInLayout,
  nextFolderName,
  normalizeTrackLayout,
  rootIndexForSelectedTracks,
  updateTrackSelection,
  visibleTracksForLayout,
} from './timeline/trackFolderLayout.js'
import { CLIP_CONTROL_DEFAULTS } from './timeline/clipControlSpec.js'
import { getSelectableSyllables } from './SyllableSplitter/syllableModel.js'
import useSnapStore from '../stores/snapStore.js'
import useTimelineDisplayStore from '../stores/timelineDisplayStore.js'
import useUIStore from '../stores/uiStore.js'
import useTimelineFocusStore from '../stores/timelineFocusStore.js'
import useQuickNotationStore from '../stores/quickNotationStore.js'
import useLoopRegionStore from '../stores/loopRegionStore.js'
import usePianoRollStore from '../stores/usePianoRollStore.js'
import useMixerStore from '../stores/mixerStore.js'
import { useToast } from './Toast.jsx'
import { usePanelVisibility } from '../windowing/contexts/PanelVisibilityContext'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry.ts'
import useInspectorStore, { revealInspector, deriveInspectorSelection } from '../stores/useInspectorStore.js'
import { register as registerKeyboardBinding } from '../windowing/managers/KeyboardManager'
import { registerEditorCommand } from '../windowing/managers/EditorCommandRegistry'
import {
  TIMELINE_GLOBAL_KEY_COMBOS,
  TIMELINE_KEY_COMBOS,
  TIMELINE_PASSTHROUGH_COMMANDS,
  resolveTimelineKeyCommand,
  timelineCommandRoute,
} from './timeline/timelineKeymap.js'

const CLIP_CONTROL_TUNER_ENABLED = import.meta.env.VITE_XLETH_CLIP_CONTROL_TUNER === '1'
const ClipControlTuner = CLIP_CONTROL_TUNER_ENABLED
  ? lazy(() => import('./timeline/clipControlTuner/ClipControlTuner.jsx'))
  : null

function isInteractiveFocusElement(element) {
  if (!element) return false
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
}

function ClipSliderRow({ label, value, min, max, step, onCommit, onPreviewChange, formatValue }) {
  const [localVal, setLocalVal] = useState(value)
  const dragging = useRef(false)

  useEffect(() => {
    if (!dragging.current) setLocalVal(value)
  }, [value])

  return (
    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>{label}</span>
      <Fader
        orientation="horizontal" fill thickness={14}
        value={localVal} min={min} max={max} defaultValue={localVal}
        fromNorm={quantizedFromNorm(min, max, step)}
        onLiveChange={(next) => {
          dragging.current = true
          setLocalVal(next)
          if (onPreviewChange) onPreviewChange(next)
        }}
        onCommit={(v) => {
          dragging.current = false
          Promise.resolve(onCommit(v))
          // Draft is cleared by the parent when committed values refresh,
          // not here — clearing on pointer-up causes a one-frame flicker.
        }}
      />
      <span style={{ fontSize: 10, color: '#888', minWidth: 40, textAlign: 'right' }}>
        {formatValue(localVal)}
      </span>
    </div>
  )
}

function clampFadePercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= 100) return 100
  return n
}

function legacyFadeTicksToPercent(ticks, durationTicks) {
  const t = Number(ticks)
  const d = Number(durationTicks)
  if (!Number.isFinite(t) || !Number.isFinite(d) || t <= 0 || d <= 0) return 0
  return clampFadePercent((t * 100) / d)
}

function normalizeFadePercents(fadeInPercent, fadeOutPercent) {
  let fadeIn = clampFadePercent(fadeInPercent)
  let fadeOut = clampFadePercent(fadeOutPercent)
  const total = fadeIn + fadeOut
  if (total > 100) {
    const scale = 100 / total
    fadeIn *= scale
    fadeOut *= scale
  }
  return { fadeInPercent: fadeIn, fadeOutPercent: fadeOut }
}

function clipFadePercent(clip, side) {
  const percentKey = side === 'in' ? 'fadeInPercent' : 'fadeOutPercent'
  const ticksKey = side === 'in' ? 'fadeInTicks' : 'fadeOutTicks'
  if (clip?.[percentKey] != null) return clampFadePercent(clip[percentKey])
  return legacyFadeTicksToPercent(clip?.[ticksKey], clip?.durationTicks)
}

function normalizeClipFadeFields(clip) {
  const fades = normalizeFadePercents(
    clipFadePercent(clip, 'in'),
    clipFadePercent(clip, 'out')
  )
  return { ...clip, ...fades }
}

export default function TimelineView({
  activeSampleId,
  currentPatternIdByTrack = {},
  setCurrentPatternIdByTrack = () => {},
  activeCenterTab = 'timeline',
}) {
  // ── Tool state ──────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState('select')
  // Draw length for the pencil. `overridden` is the "a clip taught me this
  // length" flag — see timeline/drawLength.js.
  const [drawLength, setDrawLength] = useState({ lengthTicks: 240, overridden: false }) // 1/16 = PPQ/4
  const stickyNoteLength = drawLength.lengthTicks
  // Mirror for adoptStickyNoteLength — the tools call it from a mouse handler
  // that must not close over a stale render's state.
  const drawLengthRef = useRef(drawLength)
  drawLengthRef.current = drawLength
  const snapGranularity = useSnapStore((s) => s.snapGranularity)
  const setSnapGranularity = useSnapStore((s) => s.setSnapGranularity)
  const timelineDisplaySettings = useTimelineDisplayStore((s) => s.timelineDisplaySettings)
  const focusedTrackId = useTimelineFocusStore((s) => s.focusedTrackId)
  const setFocusedTrackId = useTimelineFocusStore((s) => s.setFocusedTrackId)
  const setQuickNotationContext = useQuickNotationStore((s) => s.setContext)
  const fetchLoopRegion = useLoopRegionStore((s) => s.fetchLoopRegion)
  const timelineTrackHeaderWidth = useUIStore((s) => s.timelineTrackHeaderWidth)
  const setTimelineTrackHeaderWidth = useUIStore((s) => s.setTimelineTrackHeaderWidth)
  const focusedTrackIdRef = useRef(focusedTrackId)
  useEffect(() => { focusedTrackIdRef.current = focusedTrackId }, [focusedTrackId])
  const { showToast } = useToast()
  const { useOnVisibilityChange } = usePanelVisibility()

  // ── Draw length ("sticky note length") ────────────────────────────────────
  // Two modes:
  //   snap-following (default) — the pencil draws one snap division (SNAP 1/16
  //     -> a 1/16 clip), and it re-follows every SNAP change.
  //   overridden — the moment the user touches an existing clip whose length
  //     differs from the snap division (select / move / trim / stretch /
  //     middle-click template), that clip's exact length becomes the global
  //     draw length and SNAP changes no longer move it. It stays for the rest
  //     of the session and is only cleared by loading/closing the project, or
  //     by touching a clip that is exactly one snap division long again.
  const snapDefaultTicks = useMemo(() => {
    const beats = GRANULARITY_BEATS[snapGranularity] ?? GRANULARITY_BEATS['1/16']
    return Math.round(beats * PPQ)
  }, [snapGranularity])
  const snapDefaultTicksRef = useRef(snapDefaultTicks)
  snapDefaultTicksRef.current = snapDefaultTicks

  useEffect(() => {
    setDrawLength((prev) => drawLengthForSnap(prev, snapDefaultTicks))
  }, [snapDefaultTicks])

  // A fresh project starts back on the snap division.
  useEffect(() => {
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(
      () => setDrawLength(resetDrawLength(snapDefaultTicksRef.current))
    )
    return () => { offProjectLoaded?.() }
  }, [])

  // Adopt the length of a clip the user just touched. The timeline tools call
  // this instead of a plain setter — it is what arms/disarms the override.
  const adoptStickyNoteLength = useCallback((ticks) => {
    const prev = drawLengthRef.current
    const next = adoptDrawLength(prev, ticks, snapDefaultTicksRef.current)
    if (next === prev) return
    drawLengthRef.current = next
    setDrawLength(next)
    console.log(`[DrawLength] Adopted ${next.lengthTicks}t from clip (override=${next.overridden})`)
  }, [])

  const [patternListCollapsed, setPatternListCollapsed] = useState(false)
  // A gesture that takes several engine calls is ONE undo entry: the engine
  // records everything between undo.beginGroup and undo.endGroup as a single
  // history entry, so Ctrl+Z and Ctrl+Y always move by exactly one. See
  // timeline/undoGroup.js for why this replaced counting entries here.
  // The app's ONE shared grouper: Motion view plans (motionPlan.js) group
  // through it too, so a Motion edit can never commit an Edit view gesture's
  // group half-way (two groupers would each close the other's group).
  const withUndoGroup = withSharedUndoGroup

  // Serializes every gesture that resolves an overwrite plan against
  // clipsRef.current / patternBlocks. Those handlers read the CURRENT contents
  // of a track to decide what the incoming items bury, but the previous
  // gesture's writeback only lands after its refetch resolves — so a held
  // Ctrl+V computed its doomed set from a snapshot two pastes stale and
  // overwrote the wrong clips. Each gesture still resolves its geometry and
  // advances the edit cursor synchronously (held Ctrl+V must keep stacking
  // forward at key-repeat rate); only the engine half queues.
  const editGateRef = useRef(Promise.resolve())
  const runSerializedEdit = useCallback((fn, label = 'Timeline edit') => {
    // Every gesture queued here is one undo entry: several of them are an
    // overwrite followed by an insert or a move, which the engine records as
    // separate commands.
    const grouped = () => withUndoGroup(label, fn)
    // `.then(grouped, grouped)` — a rejected predecessor must not strand the queue.
    const run = editGateRef.current.then(grouped, grouped)
    editGateRef.current = run.then(() => {}, () => {})
    return run
  }, [withUndoGroup])
  const timelineViewRef = useRef(null)

  // FXG.4-h: graphStates needed to render macro automation lane clips on the timeline.
  const graphStates = useEffectChainStore((s) => s.graphStates)

  // ── Track state ────────────────────────────────────────────────────────────
  const [tracks, setTracks] = useState([])
  const [folderLayout, setFolderLayout] = useState(() => flatTrackLayout([]))
  const [selectedTrackIds, setSelectedTrackIds] = useState(new Set())
  const [editingFolderId, setEditingFolderId] = useState(null)
  const trackSelectionAnchorRef = useRef(null)
  const [trackHeight, setTrackHeight] = useState(DEFAULT_TRACK_HEIGHT)
  const trackHeightRef = useRef(trackHeight)
  trackHeightRef.current = trackHeight

  // FXG.4-h-r1: derive the flattened timeline row model (track rows + macro
  // automation child-lane rows). Threaded into the canvas geometry, hit-testing,
  // the left header, and the macro lane layer so all four share one source of
  // truth for where each row sits. Recomputes only when tracks or graphStates
  // change — tracks with no lanes produce the original contiguous geometry.
  const normalizedFolderLayout = useMemo(
    () => normalizeTrackLayout(folderLayout, tracks),
    [folderLayout, tracks],
  )
  const visibleTracks = useMemo(
    () => visibleTracksForLayout(normalizedFolderLayout, tracks),
    [normalizedFolderLayout, tracks],
  )
  // ── Automation clips (Phase B) ──────────────────────────────────────────
  const [automationLanes, setAutomationLanes] = useState([])
  const [automationClips, setAutomationClips] = useState([])
  // Latest-value mirror — see patternBlocksRef. The paste and Ctrl+D lane-
  // occupancy scans run inside runSerializedEdit and must see the lane as it is
  // when they run, not as it was at the keystroke.
  const automationClipsRef = useRef([])
  automationClipsRef.current = automationClips
  const [automationEnvelopes, setAutomationEnvelopes] = useState([])
  const [selectedAutomationClipIds, setSelectedAutomationClipIds] = useState(new Set())
  const selectedAutomationClipIdsRef = useRef(selectedAutomationClipIds)
  selectedAutomationClipIdsRef.current = selectedAutomationClipIds
  // Phase C — the envelope point the user last clicked, so Delete can remove it
  // and the canvas can draw it as the active one. { envelopeId, pointIndex }.
  const [selectedAutomationPoint, setSelectedAutomationPoint] = useState(null)
  const [collapsedAutomationGroups, setCollapsedAutomationGroups] = useState(new Set())
  const [automationBindingLabels, setAutomationBindingLabels] = useState({}) // { [envelopeId]: label }
  const bindingLabelFetchRef = useRef(new Set()) // envelopeIds already requested

  const automationEnvelopesById = useMemo(() => {
    const map = new Map()
    for (const env of automationEnvelopes) map.set(env.id, env)
    return map
  }, [automationEnvelopes])

  // Groups automation lanes by owner (-1 = Master) for the row-layout builder.
  // A group only renders once it has at least one lane.
  const automationGroups = useMemo(() => {
    // A lane holds clips for exactly one parameter (the knob entry point makes
    // one lane per binding), so the first clip on the lane names the lane.
    const labelByLaneId = new Map()
    for (const clip of automationClips) {
      if (labelByLaneId.has(clip.laneId)) continue
      const label = automationBindingLabels[clip.envelopeId]
      if (label) labelByLaneId.set(clip.laneId, label)
    }
    const groups = {}
    for (const lane of automationLanes) {
      const key = String(lane.ownerTrackId)
      if (!groups[key]) groups[key] = { collapsed: collapsedAutomationGroups.has(lane.ownerTrackId), lanes: [] }
      groups[key].lanes.push({ id: lane.id, index: lane.index, label: labelByLaneId.get(lane.id) ?? null })
    }
    return groups
  }, [automationLanes, automationClips, automationBindingLabels, collapsedAutomationGroups])

  const automationBindingLabelsById = useMemo(() => {
    const map = new Map()
    for (const env of automationEnvelopes) {
      const label = automationBindingLabels[env.id]
      if (label) map.set(env.id, label)
    }
    return map
  }, [automationEnvelopes, automationBindingLabels])

  // Resolve each envelope's binding into a "<EffectName> - <ParamName>" label,
  // lazily and once per envelope. The binding's effectInstanceId is stable
  // across reorders/slot changes but engine parameter lookups are nodeId-based
  // (audio_getEffectParameters), so first re-derive the CURRENT nodeId from the
  // owning chain (audio_getEffectChain already carries pluginId too, covering
  // the effect-name half without a second call) — works for both legacy Mixer
  // Chain and FX Graph effects, unlike the graph-only parameter descriptor call.
  useEffect(() => {
    const requested = bindingLabelFetchRef.current
    const pending = automationEnvelopes.filter((env) => env?.binding && !requested.has(env.id))
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      const updates = {}
      const chainCache = new Map() // ownerTrackId -> parsed chain (avoid refetching per envelope)
      for (const env of pending) {
        requested.add(env.id)
        const { ownerTrackId, effectInstanceId, parameterId } = env.binding
        try {
          if (!chainCache.has(ownerTrackId)) {
            // The engine keeps the Master chain in its own member, so
            // audio_getEffectChain(-1) returns [] — Master must be read
            // through audio_getMasterEffectChain instead.
            const raw = ownerTrackId === -1
              ? await window.xleth?.audio?.getMasterEffectChain?.()
              : await window.xleth?.audio?.getEffectChain?.(ownerTrackId)
            chainCache.set(ownerTrackId, raw ? JSON.parse(raw) : [])
          }
          const chain = chainCache.get(ownerTrackId) ?? []
          const chainEntry = Array.isArray(chain) ? chain.find((e) => e.effectInstanceId === effectInstanceId) : null
          const effectName = chainEntry?.pluginId ? (PLUGIN_NAMES[chainEntry.pluginId] ?? chainEntry.pluginId) : null
          let paramName = parameterId
          if (chainEntry?.nodeId != null) {
            const paramsRaw = await window.xleth?.audio?.getEffectParameters?.(ownerTrackId, chainEntry.nodeId)
            const params = paramsRaw ? JSON.parse(paramsRaw) : []
            const descriptor = Array.isArray(params) ? params.find((p) => p.id === parameterId) : null
            if (descriptor?.name) paramName = descriptor.name
          }
          updates[env.id] = effectName ? `${effectName} - ${paramName}` : paramName
        } catch (err) {
          console.warn(`[Timeline] Failed to resolve automation binding label for envelope ${env.id}:`, err)
        }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setAutomationBindingLabels((prev) => ({ ...prev, ...updates }))
      }
    })()
    return () => { cancelled = true }
  }, [automationEnvelopes])

  // (trackLayout is derived further down, after the pattern state it depends on:
  // the Reel lane's height comes from the notes.)
  useEffect(() => {
    const visibleIds = new Set(visibleTracks.map(track => track.id))
    setSelectedTrackIds(previous => {
      const next = new Set([...previous].filter(id => visibleIds.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [visibleTracks])

  const [contextMenu, setContextMenu] = useState(null)
  // Phase G.4: compact quick-FX popover anchored to a clip's on-canvas FX badge
  const [quickFxMenu, setQuickFxMenu] = useState(null)  // { clipId, x, y } | null
  const [trackMenu, setTrackMenu] = useState(null)         // { track, x, y }
  const [addTrackMenu, setAddTrackMenu] = useState(null)   // { x, y }
  const [confirmDialog, setConfirmDialog] = useState(null)  // { title, message, onConfirm }
  const [quantizeOpen, setQuantizeOpen] = useState(false)
  const nextTrackNum = useRef(1)
  const focusTimelinePanel = usePanelRegistry((s) => s.focusPanel)
  // Track right-click → "Video Properties…" jumps to the Video tab's Track
  // Detail view for this track (replaces the old floating flip popover).

  // ── Clip state ─────────────────────────────────────────────────────────────
  const [clips, setClips] = useState([])
  const [clipControlSpec, setClipControlSpec] = useState(CLIP_CONTROL_DEFAULTS)
  const [clipControlTunerOpen, setClipControlTunerOpen] = useState(CLIP_CONTROL_TUNER_ENABLED)
  const [regions, setRegions] = useState({})        // { [id]: region }
  const [selectedClipIds, setSelectedClipIds] = useState(new Set())
  const clipsRef = useRef([])
  // One rigid-group snapshot for BOTH clips and pattern blocks — see
  // timelineClipboard.js. Two parallel refs used to drift apart and reintroduce
  // the clip/block anchor gap on paste.
  const clipboardRef = useRef(null)
  const pencilTemplateRef = useRef(null) // middle-click template for pencil tool
  const [pencilTemplate, setPencilTemplate] = useState(null)
  const dropPreviewRef = useRef(null)
  const loadedRegionAudioRef = useRef(new Set()) // track which regions have audio loaded
  const [sources, setSources] = useState({})     // { [id]: source }
  const waveformCacheRef = useRef({})             // { [regionId]: { peaks, stride, peakWidth } }
  const waveformLruRef = useRef([])               // LRU order: most-recent at end
  const WAVEFORM_CACHE_MAX = 128                  // max cached regions before eviction
  // { ["c"+clipId]: { peaks?, samples?, startSec, endSec, ... } } for processed
  // (per-clip, collision-free) entries, but
  // { [regionId]: Array<{ peaks?, samples?, startSec, endSec, ... }> } for
  // unprocessed ones — an ARRAY, not a single slot, because many clips
  // routinely reference DIFFERENT sub-ranges of the same source region (a
  // syllable-chopped region is the common case). A single slot meant one
  // clip's fetch silently discarded every other clip's already-cached
  // window, every settle pass — see hiResFetchPlanner.js / hiResRegionCache.js.
  const hiResCacheRef = useRef({})
  const hiResFetchTimer = useRef(null)            // debounce timer for hi-res fetches
  // Bumped once per settle-pass fetch batch. A batch's async jobs check this
  // before writing a result into the cache — if a NEWER batch has already
  // started (the user kept panning before the old one finished), the old
  // batch's in-flight results are discarded instead of landing after the
  // fact and briefly showing data for a viewport the user has already left.
  // The old effect had no such guard at all: its cleanup only cleared the
  // (by-then-already-fired) setTimeout, so overlapping gestures could run
  // two full fetch passes concurrently, doubling IPC traffic for no benefit.
  const hiResFetchGenerationRef = useRef(0)
  // { ["c"+clipId]: ms timestamp } — last time getClipPeaks answered
  // ready:false for that clip (engine has no rendered buffer for it right
  // now). Without this a non-resident clip left no trace in hiResCacheRef and
  // was refetched on EVERY settle pass forever. See hiResProcessedPlanner.js.
  const hiResNotReadyRef = useRef(new Map())
  // Tuning knobs for the coalesced hi-res fetch below. Distances are in
  // PIXELS (converted to seconds at fetch time via the current zoom) so they
  // scale with zoom instead of being a fixed number of seconds that would be
  // huge relative to the viewport when zoomed in and tiny when zoomed out.
  const HIRES_MARGIN_PX = 150            // pad merged fetch windows by this much on each side
  const HIRES_MERGE_GAP_PX = 300         // batch clip requests within this many px of each other
  const HIRES_MAX_ENTRIES_PER_REGION = 12 // cap on distinct cached windows per region (FIFO evict)
  const HIRES_MAX_FETCHES_PER_REGION = 6  // cap merged fetches issued per region per settle pass
  // Cap on per-clip processed-buffer fetches per settle pass, across ALL
  // regions. Processed clips can't be merged (no two clips share a processed
  // buffer) so a cap is the only bound available — and it was missing: a
  // stretch-heavy viewport issued one fetch per visible processed clip, 118 of
  // them at once on the real BFDIA 9 project, all serialised on the engine
  // worker's single JS thread ahead of every other RPC. Nearest-the-viewport-
  // centre clips win the budget; the rest keep the low-res fallback until a
  // later pass. See hiResProcessedPlanner.js for the measurements.
  const HIRES_MAX_PROCESSED_FETCHES = 24
  const HIRES_NOT_READY_BACKOFF_MS = 1500  // don't re-ask for a not-ready clip buffer sooner than this
  const HIRES_NOT_READY_MAX_AGE_MS = 30000 // prune not-ready stamps older than this
  const regionSampleRates = useRef({})            // { [regionId]: sampleRate } — learned from getRegionPeaks
  const clipPeakCacheRef = useRef({})             // { [clipId]: { peaks, stride, peakWidth, pitchOffset, pitchOffsetCents, reversed, stretchRatio } }
  const clipPeakRetryRef = useRef({})             // { [clipId]: retryCount } — resets on param change or success

  // ── Pattern state ──────────────────────────────────────────────────────────
  const [patternBlocks, setPatternBlocks] = useState([])
  // Latest-value mirror, the same pattern timelineKeyHandlerRef uses below.
  // The overwrite resolver runs inside runSerializedEdit, i.e. after at least
  // one await, so a closure over `patternBlocks` there would be the list as of
  // the keystroke rather than as of the moment the work actually runs.
  const patternBlocksRef = useRef([])
  patternBlocksRef.current = patternBlocks
  const [patterns, setPatterns] = useState({})        // { [id]: pattern }
  // Latest-value mirror for the Inspector's single-block selection (its source is
  // {block.trackId, pattern.regionId}); read at selection time, never a dependency.
  const patternsRef = useRef({})
  patternsRef.current = patterns

  // ── Reel lane ──────────────────────────────────────────────────────────────
  // One ghost clip per note, DERIVED from the blocks + patterns above on every
  // data change (never stored), so a piano roll edit moves the clips as soon as
  // the pattern refetch lands. Only Pattern tracks with a video source get a lane.
  const reelModel = useMemo(
    () => buildReelModel({ tracks, patternBlocks, patterns, regions, sources }),
    [tracks, patternBlocks, patterns, regions, sources],
  )
  const reelCollapsed = useReelLaneStore((s) => s.collapsed)
  // The layout only needs {has lane, collapsed, deepest overlap} per track. Keyed
  // by a string so a note moving (new model, same depths) does NOT rebuild the row
  // layout and repaint the grid. A Clone's lane (its whole row) collapses with its
  // source's Reel lane: a source and its Clones are one group.
  const reelLanesKey = useMemo(
    () => reelLanesKeyFor(reelModel, reelCollapsed, tracks),
    [reelModel, reelCollapsed, tracks],
  )
  const reelLanes = useMemo(() => {
    const lanes = {}
    for (const part of reelLanesKey.split(';')) {
      if (!part) continue
      const [trackId, collapsedFlag, subRows] = part.split(':')
      lanes[trackId] = { collapsed: collapsedFlag === '1', subRows: Number(subRows) }
    }
    return lanes
  }, [reelLanesKey])

  // ── Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2, R17-R20) ─────────────
  // The Roam and Sweep key lanes are gone from the Edit view (R17): motion is
  // edited in Motion view, which replaces the header column and the canvas when
  // view === 'motion'. One fetch feeds both: Motion view's rows and the Edit
  // view's motion marker on the track headers (R18).
  const timelineView = useMotionViewStore((s) => s.view)
  const isMotionView = timelineView === 'motion'
  const motionGraph = useMotionViewStore((s) => s.graph)
  const motionHeaderWidth = useMotionViewStore((s) => s.motion.headerWidth)
  const timelineViewNameRef = useRef(timelineView)
  timelineViewNameRef.current = timelineView
  const motionViewRef = useRef(null)
  const [motionKeyHost, setMotionKeyHost] = useState(null)
  const [motionReveal, setMotionReveal] = useState(null)

  const trackLayout = useMemo(
    () => buildTrackLayout({ tracks, graphStates, folderLayout: normalizedFolderLayout, trackHeight, automationGroups, reelLanes }),
    [tracks, graphStates, normalizedFolderLayout, trackHeight, automationGroups, reelLanes],
  )
  // Every track's Lens / Roam / Sweep / Parent / Masks (+ every clip's Lens while
  // Motion view is shown). motionTrackIds = the tracks the Edit header marks (R18).
  const motionData = useMotionData({
    tracks, clips, patternBlocks, patterns, regions, includeClipLens: isMotionView,
  })
  const motionTrackIds = motionData.motionTrackIds
  const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())

  // ── Transport state ────────────────────────────────────────────────────────
  // A ref, not state: every reader is an event handler or a frame callback,
  // and nothing rendered depends on it.
  const isPlayingRef = useRef(false)
  const playheadBeatRef = useRef(0)
  // Snapshots cue lane, pinned under the ruler on the arrangement's own scale.
  const cueLaneRef = useRef(null)
  const snapshotCues = useSnapshotCues(playheadBeatRef)
  const bpmRef = useRef(140)
  const stoppedPreviewSeekSchedulerRef = useRef(null)

  useEffect(() => {
    const scheduler = createXlethStoppedPreviewSeekScheduler({
      isPlaying: () => isPlayingRef.current,
    })
    stoppedPreviewSeekSchedulerRef.current = scheduler
    return () => {
      scheduler.dispose()
      if (stoppedPreviewSeekSchedulerRef.current === scheduler) {
        stoppedPreviewSeekSchedulerRef.current = null
      }
    }
  }, [])

  // ── Auto Scroll toggle (playback-only "follow the playhead" mode) ──────────
  // Read imperatively (ref) from the 60fps playheadClock frame handler and
  // the wheel/pan handlers below, which live outside React's render cycle.
  const autoScrollEnabledRef = useRef(useAutoScrollStore.getState().enabled)
  useEffect(() => useAutoScrollStore.subscribe((s) => {
    autoScrollEnabledRef.current = s.enabled
  }), [])
  // True while playback is following the playhead — manual horizontal
  // scroll/pan is locked out during this window (zoom/resize still works).
  // Both refs read here are updated imperatively outside React's render
  // cycle, so this must be a function (called fresh at use-sites), not a
  // value snapshotted once per render.
  const isFollowLocked = useCallback(
    () => isPlayingRef.current && autoScrollEnabledRef.current,
    [],
  )

  // ── Canvas refs ────────────────────────────────────────────────────────────
  // Declared before the zoom/scroll hooks so their onCommit callbacks (below)
  // can close over canvasRef/rulerRef for imperative, per-frame redraws.
  const canvasRef = useRef(null)    // TimelineCanvas imperative handle
  // Hi-res waveform results land one IPC reply at a time but within a few ms
  // of each other, and redrawContent() is a full synchronous canvas rebuild —
  // so every redraw but the last was immediately overwritten. Collapse them
  // to one per frame. Scoped to this one reason string on purpose: every
  // other path (drag commit, zoom tick) keeps calling redrawContent directly.
  const hiResRedrawRef = useRef(null)
  if (!hiResRedrawRef.current) {
    hiResRedrawRef.current = createHiResRedrawScheduler(() => {
      canvasRef.current?.redrawContent('hires-waveform')
    })
  }
  useEffect(() => () => hiResRedrawRef.current?.cancel(), [])
  const rulerRef = useRef(null)     // TimelineRuler imperative handle
  // DOM overlays that sit on top of / beside those canvases. They are NOT
  // canvases, but their placement is the same function of (pixelsPerBeat,
  // scrollOffset), so they get pushed a frame from commitViewportRedraw too.
  const loopRegionBarRef = useRef(null)
  const scrollbarRef = useRef(null)
  const [canvasWidth, setCanvasWidth] = useState(800)
  const canvasAreaRef = useRef(null)

  // ── Zoom / Scroll ──────────────────────────────────────────────────────────
  // pixelsPerBeatRef/scrollOffsetRef are the source of truth for the draw
  // path. applyZoom/applyScroll write the ref synchronously and invoke
  // onCommit immediately — a direct, imperative redraw with no React render
  // in between. The pixelsPerBeat/scrollOffset React state is synced
  // afterward on a trailing ~100ms debounce (inside the hooks), purely for
  // consumers that only need the resting value (viewport-aware data fetches,
  // effect deps, the toolbar zoom readout). Anything that is POSITIONED on
  // screen — FX badges, the scrollbar thumb, the loop region bar — follows the
  // refs per frame via commitViewportRedraw instead; see below.
  const commitViewportRedraw = useCallback((reason) => {
    canvasRef.current?.redrawGrid(reason)
    canvasRef.current?.redrawContent(reason)
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
    rulerRef.current?.redrawOverlay()
    // DOM followers — same frame, same refs, so nothing lags behind the
    // canvases while the animator eases.
    canvasRef.current?.repositionFxBadges()
    loopRegionBarRef.current?.applyView()
    cueLaneRef.current?.applyView()
    scrollbarRef.current?.applyView()
    // Motion view's key area reads the same refs (5.2): same frame, same zoom.
    motionViewRef.current?.redraw()
  }, [])

  const { scrollOffset, scrollOffsetRef, maxScrollRef, applyScroll, scrollBy, scrollTo, setMaxScroll } =
    useTimelineScroll(() => commitViewportRedraw('scroll'))

  const { pixelsPerBeat, pixelsPerBeatRef, minPpbRef, setMinPpb, applyZoom } =
    useTimelineZoom((ppb) => {
      commitViewportRedraw('zoom')
      // Keep the scroll clamp bound current on every tick, not just at
      // settle — it's a plain ref write (no re-render), so this is
      // effectively free, and staying current here avoids a stale bound
      // clipping the animator's cursor-anchored scroll math mid-gesture.
      // (See the ON-SETTLE maxScroll effect below for the general-purpose
      // recompute that also covers canvasWidth/totalBeats changes.)
      setMaxScroll(scrollBoundFor(ppb))
    })
  const scrollContainerRef = useRef(null)

  // ── View animator: FL Studio-style spring easing ───────────────────────────
  // Wheel input (and playhead-follow) no longer jump pixelsPerBeat/scrollX
  // straight to their final value — they set a TARGET on this animator, and
  // its single rAF loop eases the ref-backed current value toward it every
  // frame via applyZoom/applyScroll above (which already do the imperative
  // redraw + debounced-state-sync; the animator only changes how often/with
  // what values they're called, never bypasses them). Piano Roll mounts its
  // own separate instance of the exact same hook — see PianoRoll.jsx.
  //
  // Cursor-anchored zoom (requirement: stay anchored for the WHOLE
  // animation, not just the final frame) needs scrollX to be a function of
  // ppb on every tick, not an independently-eased spring — so while
  // zoomAnchorRef is set, onTick derives scrollX from the anchor + the
  // CURRENT (already-eased) ppb every frame, and slaves the scrollX spring
  // to that value via setCurrent so a plain scroll gesture starting right
  // after a zoom hands off smoothly instead of jumping.
  const zoomAnchorRef = useRef(null) // { beat, pixelX } while a ctrl+wheel zoom is easing
  const viewAnimatorRef = useRef(null)
  const viewAnimator = useViewAnimator({
    springs: {
      ppb: { value: pixelsPerBeatRef.current, space: 'log' },
      scrollX: { value: scrollOffsetRef.current },
      scrollY: { value: 0 },
    },
    getDrawStats: () => canvasRef.current?.getDrawStats(),
    onTick: (values) => {
      // Zoom FIRST: applyZoom's onCommit refreshes both the ppb ref and the
      // maxScroll bound that the scroll clamp below depends on. Clamping the
      // anchor-derived scroll against a bound computed for the PREVIOUS
      // frame's zoom level is wrong by exactly one frame every frame of a
      // zoom-out, which is where the bound is moving fastest.
      applyZoom(values.ppb)

      const anchor = zoomAnchorRef.current
      const requested = anchoredScrollX(values.scrollX, anchor, values.ppb)

      // applyScroll clamps to [0, maxScroll] and RETURNS what it committed.
      // Feed that back into the spring, never the raw request — see
      // viewportAnchor.js for the invariant and why violating it makes the
      // view bounce during ctrl+wheel zoom.
      const committed = applyScroll(requested)
      const writeback = scrollSpringWriteback(requested, committed, Boolean(anchor))
      if (writeback !== null) viewAnimatorRef.current?.setCurrent('scrollX', writeback)
      if (anchor && viewAnimatorRef.current?.isAtRest('ppb')) zoomAnchorRef.current = null

      const sc = scrollContainerRef.current
      if (sc) sc.scrollTop = values.scrollY
    },
  })
  viewAnimatorRef.current = viewAnimator

  // ── Track-header column resize ─────────────────────────────────────────────
  const timelineBodyRef = useRef(null)
  const [headerDragLineX, setHeaderDragLineX] = useState(null)

  const handleHeaderResizeStart = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    // Each view keeps its own header width (R19): Motion view's lives in
    // motionViewStore (240..720, saved with the project), the Edit view's in uiStore.
    const motionHeader = timelineViewNameRef.current === 'motion'
    const startWidth = motionHeader ? useMotionViewStore.getState().motion.headerWidth : timelineTrackHeaderWidth
    const bodyEl = timelineBodyRef.current

    if (bodyEl) {
      const bodyRect = bodyEl.getBoundingClientRect()
      setHeaderDragLineX(startX - bodyRect.left)
    }
    document.body.style.cursor = 'col-resize'

    const onMove = (moveE) => {
      if (!bodyEl) return
      const bodyRect = bodyEl.getBoundingClientRect()
      setHeaderDragLineX(moveE.clientX - bodyRect.left)
    }

    const onUp = (upE) => {
      const dx = upE.clientX - startX
      if (motionHeader) {
        useMotionViewStore.getState().setHeaderWidth(startWidth + dx)
      } else {
        const newWidth = Math.max(120, Math.min(480, startWidth + dx))
        setTimelineTrackHeaderWidth(newWidth)
      }
      setHeaderDragLineX(null)
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [timelineTrackHeaderWidth, setTimelineTrackHeaderWidth])

  // ── Motion view: saved view state, per-view height and scroll (R19) ─────────
  // The view state rides the project (motionViewPersistence: load on project
  // load, debounced push, never undoable or dirtying).
  useEffect(() => startMotionViewSession(), [])

  // The Edit view's own track height and vertical scroll live in motionViewStore
  // too, so they survive a view switch and a save. Ours -> the store on change;
  // the store -> ours only when it changes from OUTSIDE (a project load), never
  // echoing our own (debounced) scroll writes back into a scroll in progress.
  useEffect(() => {
    useMotionViewStore.getState().setEditTrackHeight(trackHeight)
  }, [trackHeight])
  const editScrollTopRef = useRef(0)
  const editScrollWrittenRef = useRef(0)
  const editScrollTimerRef = useRef(null)
  const saveEditScroll = useCallback((y, now = false) => {
    editScrollTopRef.current = y
    if (editScrollTimerRef.current) clearTimeout(editScrollTimerRef.current)
    editScrollTimerRef.current = null
    const write = () => {
      editScrollTimerRef.current = null
      editScrollWrittenRef.current = Math.round(Math.max(0, y))
      useMotionViewStore.getState().setEditScrollY(y)
    }
    if (now) write()
    else editScrollTimerRef.current = setTimeout(write, 200)
  }, [])
  useEffect(() => () => { if (editScrollTimerRef.current) clearTimeout(editScrollTimerRef.current) }, [])
  const restoreEditScroll = useCallback((y) => {
    const apply = () => {
      const sc = scrollContainerRef.current
      if (!sc) return
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight)
      sc.scrollTop = Math.max(0, Math.min(max, y))
      editScrollTopRef.current = sc.scrollTop
      viewAnimatorRef.current?.setCurrent('scrollY', sc.scrollTop)
    }
    apply()
    // The rows may lay out a frame later (a project just loaded): once more then.
    requestAnimationFrame(apply)
  }, [])
  useEffect(() => useMotionViewStore.subscribe((s, prev) => {
    if (s.edit.trackHeight !== prev.edit.trackHeight && s.edit.trackHeight !== trackHeightRef.current) {
      setTimelineTrackHeight(s.edit.trackHeight)
      setTrackHeight(s.edit.trackHeight)
    }
    if (s.edit.scrollY !== prev.edit.scrollY && s.edit.scrollY !== editScrollWrittenRef.current
      && s.view === 'edit') {
      editScrollWrittenRef.current = s.edit.scrollY
      restoreEditScroll(s.edit.scrollY)
    }
  }), [restoreEditScroll])

  // A view switch changes no data, no selection, no zoom and no playback: the
  // Edit view hands its scroll to the store as it goes and takes it back on return.
  const prevViewRef = useRef(timelineView)
  useLayoutEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = timelineView
    if (prev === timelineView) return
    if (timelineView === 'motion') saveEditScroll(editScrollTopRef.current, true)
    else restoreEditScroll(useMotionViewStore.getState().edit.scrollY)
    // Both views draw from the same zoom / scroll refs: paint the one now shown.
    requestAnimationFrame(() => commitViewportRedraw('view'))
  }, [timelineView, saveEditScroll, restoreEditScroll, commitViewportRedraw])

  // 'xleth-motion-reveal' { trackId, path } (Edit header marker, Inspector "Show
  // in Motion view"): switch to Motion view, open that path, select and scroll to it.
  useMotionRevealListener(setMotionReveal)
  // A reveal is one-shot: leaving Motion view drops it, so the next Motion view
  // mount does not reveal it again (a view switch never changes the selection,
  // the focused track or the scroll). A reveal sent from the Edit view switches
  // the view in the same event, so it is still here when Motion view mounts.
  useEffect(() => { if (!isMotionView) setMotionReveal(null) }, [isMotionView])

  // Video-companion FX defaults are read imperatively by seedVideoFxDefaults on
  // a checkbox click, so they have to be in the store before the first click —
  // not lazily on first read.
  const hydrateClipVideoFxDefaults = useClipVideoFxDefaultsStore((st) => st.hydrate)
  useEffect(() => { hydrateClipVideoFxDefaults() }, [hydrateClipVideoFxDefaults])

  // Declick is engine-owned and no longer surfaced in the UI — the engine keeps
  // applying its stored declick envelope; there is simply no control for it.
  const [globalStretchMethod, setGlobalStretchMethod] = useState(1) // 1=PSOLA,2=Rubber,3=WSOLA,4=PhaseVocoder,5=WORLD
  const stretchMountedRef = useRef(true)
  useEffect(() => {
    stretchMountedRef.current = true
    const refreshGlobalStretchMethod = () => {
      window.xleth?.timeline?.getGlobalStretchMethod()
        .then(m => { if (stretchMountedRef.current && m != null) setGlobalStretchMethod(m) })
        .catch(() => {})
    }
    refreshGlobalStretchMethod()
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(refreshGlobalStretchMethod)

    const onGlobalStretchMethodChanged = (event) => {
      const method = Number(event.detail?.method)
      if (method >= 1 && method <= 5) setGlobalStretchMethod(method)
    }
    window.addEventListener('xleth:globalStretchMethod-changed', onGlobalStretchMethodChanged)

    return () => {
      stretchMountedRef.current = false
      offProjectLoaded?.()
      window.removeEventListener('xleth:globalStretchMethod-changed', onGlobalStretchMethodChanged)
    }
  }, [])

  // ── Loop region: refresh committed mirror on mount + project load ──────────
  useEffect(() => {
    fetchLoopRegion()
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(fetchLoopRegion)
    return () => { offProjectLoaded?.() }
  }, [fetchLoopRegion])

  // ── Pencil template (middle-click quick copy) ──────────────────────────────

  const updatePencilTemplate = useCallback((template) => {
    pencilTemplateRef.current = template
    setPencilTemplate(template)
    if (template) adoptStickyNoteLength(template.durationTicks)
  }, [adoptStickyNoteLength])

  // ── Select syllable index for pencil drawing ───────────────────────────────
  // Creates/updates a pencil template that carries the syllable index so the
  // pencilTool picks it up when drawing new clips.
  const handleSelectSyllable = useCallback((syllableIndex) => {
    const existing = pencilTemplateRef.current
    if (existing) {
      updatePencilTemplate({ ...existing, syllableIndex })
      return
    }
    // No template yet — build one from the active sample
    if (activeSampleId == null) return
    const region = regions[activeSampleId]
    if (!region) return
    updatePencilTemplate({
      regionId:          region.id,
      regionOffsetTicks: 0,
      durationTicks:     stickyNoteLength,
      velocity:          1.0,
      pitchOffset:       0,
      syllableIndex,
      displayName:       region.name || '?',
      label:             region.label,
    })
  }, [activeSampleId, regions, stickyNoteLength, updatePencilTemplate])

  // ── Open Quick Notation panel ──────────────────────────────────────────────
  const handleOpenQuickNotation = useCallback(() => {
    const region = pencilTemplateRef.current
      ? regions[pencilTemplateRef.current.regionId]
      : activeSampleId != null ? regions[activeSampleId] : null
    if (!region || region.label !== 'Quote') return
    const syllables = getSelectableSyllables(region.syllables)
    if (syllables.length === 0) return
    setQuickNotationContext({
      regionId: region.id,
      regionName: region.name,
      syllableCount: syllables.length,
      regionDurationTicks: regionDurationToTicks(region.startTime, region.endTime, bpmRef.current),
      region: {
        id: region.id,
        name: region.name,
        sourceId: region.sourceId,
        startTime: region.startTime,
        endTime: region.endTime,
        audioFilePath: region.audioFilePath,
        hasSwappedAudio: region.hasSwappedAudio,
        swappedAudioPath: region.swappedAudioPath,
      },
      syllables: region.syllables ?? [],
    })
    usePanelRegistry.getState().openPanel('quickNotation')
  }, [activeSampleId, regions, setQuickNotationContext])

  // Clear pencil template when user selects a different sample in Sample Selector
  useEffect(() => {
    if (activeSampleId != null && pencilTemplateRef.current != null) {
      updatePencilTemplate(null)
    }
  }, [activeSampleId, updatePencilTemplate])

  // ── Fetch tracks from engine ───────────────────────────────────────────────

  const fetchTracks = useCallback(async () => {
    try {
      const [t, rawLayout] = await Promise.all([
        window.xleth?.timeline?.getTracks(),
        window.xleth?.timeline?.getTrackLayout?.(),
      ])
      if (t) {
        const nextLayout = normalizeTrackLayout(rawLayout, t)
        setTracks(t)
        setFolderLayout(nextLayout)
        // Keep mixer in sync without an extra IPC round-trip
        useMixerStore.getState().syncFromTimeline(t, nextLayout)
        // FX Graph edits are undo-tracked in the engine, so a global undo/redo can
        // revert a track's graphState underneath the renderer. This is the single
        // choke point every undo path already goes through; the resync no-ops
        // unless the engine's graph actually differs from the store's.
        void useEffectChainStore.getState().resyncGraphStatesFromTracks?.(t)
        console.log(`[Timeline] Tracks loaded: ${t.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  // Every clip mutation ends in a refetch, and two overlapping mutations resolve
  // in ARRIVAL order — so a slow snapshot taken before a move could land after
  // the fast one taken after it, and the canvas visibly reverted (hold Ctrl+V
  // while a move's refetch is in flight). The generation guard drops any
  // snapshot a newer fetch has already superseded, the same way the hi-res
  // waveform fetcher supersedes a stale batch.
  const fetchClipsGenerationRef = useRef(0)
  const fetchClips = useCallback(async () => {
    const myGeneration = ++fetchClipsGenerationRef.current
    try {
      const c = await window.xleth?.timeline?.getClips()
      if (myGeneration !== fetchClipsGenerationRef.current) return
      if (c) {
        const normalized = c.map(normalizeClipFadeFields)
        setClips(normalized)
        clipsRef.current = normalized
        // Close any floating clip-FX editor whose clip no longer exists. This is
        // the one funnel every clip mutation flows through (delete tool, batch
        // delete, split's remove+re-add under new ids, bulk ops, cascading region
        // deletes), so reconciling here catches them all without touching each
        // call site. Mirrors closeEffectEditorForNode's role for chain nodes.
        reconcileClipFxEditors(normalized)
        console.log(`[TimelineClips] Clips loaded: ${normalized.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  // The bounded counterpart to fetchClips: splice in the post-state a mutation
  // just handed back instead of refetching every clip in the project.
  //
  // Every batch and single-clip mutation RPC now answers with the clips it
  // touched (see clipsByIdToJs, XlethEngineService.cpp), so the change set is
  // known and small — a 200-clip drag no longer drags the whole project across
  // two process boundaries and rebuilds every clip object on arrival. See
  // timeline/clipReconcile.js for the identity rules; unchanged clips keep
  // their existing object so downstream memos survive.
  //
  // fetchClips survives for the paths where the change set is genuinely
  // unbounded: undo/redo, project load, and the engine-driven clips-changed
  // broadcast (cascading region deletes).
  //
  // It shares fetchClips' generation counter deliberately: a delta is only
  // valid against the list it was computed from, so an in-flight full refetch
  // must win — bumping the counter here also makes any refetch that started
  // BEFORE this delta discard itself on arrival rather than reinstating the
  // pre-mutation snapshot.
  const applyClipDelta = useCallback(({ updated = [], removed = [] } = {}) => {
    fetchClipsGenerationRef.current++
    const next = reconcileById(clipsRef.current, {
      updated, removed, normalize: normalizeClipFadeFields,
    })
    if (next === clipsRef.current) return
    clipsRef.current = next
    setClips(next)
    // Same funnel duty fetchClips has: a split/paste/delete can retire the clip
    // a floating clip-FX editor is bound to.
    if (removed?.length) reconcileClipFxEditors(next)
  }, [])

  // Adds clips and splices them in from the engine's reply.
  //
  // Goes through pasteClipsBatch with nothing to remove rather than
  // timeline.addClip: the paste answers with the clips it inserted, addClip
  // answers with a bare id. That id used to be followed by fetchClips(), which
  // on a 3000-clip project is ~150 ms of engine time and megabytes across two
  // process hops, for every single clip drawn with the pencil. Field handling is
  // identical (both unmarshal through jsToClip) and it is one undo entry either
  // way.
  const addClipsAndSplice = useCallback(async (payloads) => {
    const res = await window.xleth?.timeline?.pasteClipsBatch({ removeClipIds: [], clips: payloads })
    if (Array.isArray(res?.clips)) {
      applyClipDelta({ updated: res.clips, removed: res.removedIds ?? [] })
    } else {
      // An addon that predates post-state replies: fall back to the refetch.
      await fetchClips()
    }
    return res?.newIds ?? []
  }, [applyClipDelta, fetchClips])

  const fetchRegions = useCallback(async () => {
    try {
      const r = await window.xleth?.timeline?.getRegions()
      if (r) {
        const map = {}
        r.forEach((reg) => { map[reg.id] = reg })
        setRegions(map)
        console.log(`[TimelineClips] Regions loaded: ${r.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatterns = useCallback(async () => {
    try {
      const list = await window.xleth?.timeline?.getAllPatterns()
      if (list) {
        const map = {}
        list.forEach((p) => { map[p.id] = p })
        setPatterns(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatternBlocks = useCallback(async () => {
    try {
      const b = await window.xleth?.timeline?.getPatternBlocks()
      if (b) setPatternBlocks(b)
    } catch { /* engine not ready */ }
  }, [])

  // applyClipDelta's counterpart for pattern blocks. The batch add/paste RPCs
  // return the blocks they inserted and the ids they buried, so a 64-block paste
  // is genuinely ONE round trip — it used to be one addPatternBlock per block
  // plus a setPatternBlockLoop each, and then a full getPatternBlocks on top.
  // The paths that still fire N× single RPCs (move, remove) keep the refetch.
  const applyPatternBlockDelta = useCallback(({ updated = [], removed = [] } = {}) => {
    // Reads and writes the ref rather than using a functional setState, matching
    // applyClipDelta: back-to-back deltas inside one gesture must each see the
    // previous one, and the rest of this file reads patternBlocksRef
    // synchronously right after a mutation.
    const next = reconcileById(patternBlocksRef.current, { updated, removed })
    if (next === patternBlocksRef.current) return
    patternBlocksRef.current = next
    setPatternBlocks(next)
  }, [])

  const fetchAutomationLanes = useCallback(async () => {
    try {
      const l = await window.xleth?.automation?.getLanes()
      if (l) setAutomationLanes(l)
    } catch { /* engine not ready */ }
  }, [])

  const fetchAutomationClips = useCallback(async () => {
    try {
      const c = await window.xleth?.automation?.getClips()
      if (c) setAutomationClips(c)
    } catch { /* engine not ready */ }
  }, [])

  const fetchAutomationEnvelopes = useCallback(async () => {
    try {
      const e = await window.xleth?.automation?.getEnvelopes()
      if (e) setAutomationEnvelopes(e)
    } catch { /* engine not ready */ }
  }, [])

  const fetchAutomationAll = useCallback(async () => {
    await Promise.all([fetchAutomationLanes(), fetchAutomationClips(), fetchAutomationEnvelopes()])
  }, [fetchAutomationLanes, fetchAutomationClips, fetchAutomationEnvelopes])

  const fetchSources = useCallback(async () => {
    try {
      const s = await window.xleth?.timeline?.getSources()
      if (s) {
        const map = {}
        s.forEach(src => { map[src.id] = src })
        setSources(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  // ── Rebuild audio mappings for regions that don't have samples loaded yet ──
  const rebuildAudioMappings = useCallback(async (regionsMap, cancelled) => {
    const regionList = Object.values(regionsMap)
    const unloaded = regionList.filter(r => r.sourceId != null && !loadedRegionAudioRef.current.has(r.id))
    if (unloaded.length === 0) return

    // Fetch sources to get file paths
    let sources = []
    try {
      sources = await window.xleth?.timeline?.getSources() || []
    } catch { return }
    if (cancelled.current) return

    const sourceById = {}
    sources.forEach(s => { sourceById[s.id] = s })

    for (const region of unloaded) {
      if (cancelled.current) break
      const source = sourceById[region.sourceId]
      if (!source?.filePath || region.startTime == null || region.endTime == null) continue

      try {
        // Swap-aware: bridge loads swappedAudioPath if region.hasSwappedAudio,
        // else the original source range. It also calls mapRegionToSample.
        const sampleId = await window.xleth?.audio?.loadRegionAudio(region.id)
        if (cancelled.current) break
        if (sampleId != null && sampleId >= 0) {
          loadedRegionAudioRef.current.add(region.id)
          console.log(`[Timeline] Audio mapped: region=${region.id} → sample=${sampleId}${region.hasSwappedAudio ? ' (swapped)' : ''}`)
        }
      } catch (e) {
        console.warn(`[Timeline] Audio load failed for region ${region.id}:`, e.message)
      }
    }
  }, [])

  // ── Quantize apply (per-edge batch) ────────────────────────────────────────
  const handleQuantizeApply = useCallback(async ({ startAction, endAction }) => {
    const clipSel  = clipsRef.current.filter(c => selectedClipIds.has(c.id))
    const blockSel = patternBlocks.filter(b => selectedBlockIds.has(b.id))
    if (clipSel.length === 0 && blockSel.length === 0) {
      console.warn('[Quantize] nothing selected, closing dialog')
      setQuantizeOpen(false)
      return
    }
    const { specs, skipped } = buildQuantizeSpecs(
      clipSel, blockSel, startAction, endAction, snapGranularity
    )
    console.log(`[Quantize] start=${startAction} end=${endAction} snap=${snapGranularity} `
      + `→ ${specs.length} specs, ${skipped.length} skipped`)
    if (skipped.length > 0) {
      for (const s of skipped) console.log(`[Quantize] skip ${s.kind} id=${s.id}: ${s.reason}`)
    }
    if (specs.length === 0) {
      setQuantizeOpen(false)
      return
    }
    try {
      const quantized = await window.xleth?.timeline?.quantizeClipsBatch(specs)
      applyClipDelta({ updated: quantized ?? [] })
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[Quantize] quantizeClipsBatch failed:', err)
      await fetchClips()
    }
    setQuantizeOpen(false)
  }, [selectedClipIds, selectedBlockIds, patternBlocks, snapGranularity, fetchClips, applyClipDelta])

  useEffect(() => {
    fetchTracks()
    fetchClips()
    fetchRegions()
    fetchSources()
    fetchPatterns()
    fetchPatternBlocks()
    fetchAutomationAll()

    // Refresh regions/clips when samples are added/removed via SamplePicker
    const onRegionsChanged = () => { loadedRegionAudioRef.current.clear(); fetchTracks(); fetchRegions(); fetchSources() }
    const onClipsChanged = () => { fetchTracks(); fetchClips() }
    const onPatternsChanged = () => { fetchPatterns() }
    const onPatternBlocksChanged = () => { fetchPatternBlocks() }
    const onPatternChanged = () => { fetchPatterns() }
    const onAutomationChanged = () => { fetchAutomationAll() }
    // "Create automation clip" on a mixer knob asks the timeline to REVEAL the
    // lane it just wrote to: expand the owning group (or the pinned Master
    // group) if it was collapsed, refresh, and select the new clip so the user
    // lands on something they can immediately edit.
    const onAutomationReveal = (e) => {
      const { ownerTrackId, clipId } = e.detail || {}
      if (ownerTrackId != null) {
        setCollapsedAutomationGroups((prev) => {
          if (!prev.has(ownerTrackId)) return prev
          const next = new Set(prev)
          next.delete(ownerTrackId)
          return next
        })
      }
      fetchAutomationAll().then(() => {
        if (Number.isInteger(clipId) && clipId >= 0) setSelectedAutomationClipIds(new Set([clipId]))
      })
    }
    const onTracksChanged = (e) => {
      const { trackId, patch } = e.detail || {}
      if (trackId != null && patch && typeof patch === 'object') {
        setTracks((prev) => prev.map((track) =>
          track.id === trackId ? { ...track, ...patch } : track
        ))
      } else {
        fetchTracks()
      }
    }
    const onRegionAudioLoaded = (e) => {
      if (e.detail?.regionId != null) loadedRegionAudioRef.current.add(e.detail.regionId)
    }
    timelineEvents.addEventListener('timeline-tracks-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-regions-changed', onRegionsChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onClipsChanged)
    timelineEvents.addEventListener('timeline-region-audio-loaded', onRegionAudioLoaded)
    timelineEvents.addEventListener('timeline-patterns-changed', onPatternsChanged)
    timelineEvents.addEventListener('timeline-pattern-blocks-changed', onPatternBlocksChanged)
    timelineEvents.addEventListener('timeline-pattern-changed', onPatternChanged)
    timelineEvents.addEventListener('timeline-automation-changed', onAutomationChanged)
    timelineEvents.addEventListener('timeline-automation-reveal', onAutomationReveal)
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(() => {
      loadedRegionAudioRef.current.clear()
      // Clip ids are reassigned wholesale by a load, so any open clip-FX editor
      // is addressing a stale clip. Same reasoning as closeAllEffectEditors()
      // on project load in effectChainStore.js.
      closeAllClipFxEditors()
      fetchTracks(); fetchClips(); fetchRegions(); fetchSources(); fetchPatterns(); fetchPatternBlocks()
      fetchAutomationAll()
    })
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-regions-changed', onRegionsChanged)
      timelineEvents.removeEventListener('timeline-clips-changed', onClipsChanged)
      timelineEvents.removeEventListener('timeline-region-audio-loaded', onRegionAudioLoaded)
      timelineEvents.removeEventListener('timeline-patterns-changed', onPatternsChanged)
      timelineEvents.removeEventListener('timeline-pattern-blocks-changed', onPatternBlocksChanged)
      timelineEvents.removeEventListener('timeline-pattern-changed', onPatternChanged)
      timelineEvents.removeEventListener('timeline-automation-changed', onAutomationChanged)
      timelineEvents.removeEventListener('timeline-automation-reveal', onAutomationReveal)
      offProjectLoaded?.()
    }
  }, [fetchTracks, fetchClips, fetchRegions, fetchSources, fetchPatterns, fetchPatternBlocks, fetchAutomationAll])

  // ── Rebuild audio mappings when regions change (e.g. on project load) ──────
  useEffect(() => {
    const cancelled = { current: false }
    if (Object.keys(regions).length > 0) {
      rebuildAudioMappings(regions, cancelled)
    }
    return () => { cancelled.current = true }
  }, [regions, rebuildAudioMappings])

  // ── Sync track counter from existing track names on mount/re-entry ──────────
  useEffect(() => {
    if (tracks.length > 0) {
      const maxNum = tracks.reduce((max, t) => {
        const match = t.name.match(/^Track (\d+)$/)
        return match ? Math.max(max, parseInt(match[1])) : max
      }, 0)
      nextTrackNum.current = maxNum + 1
    }
  }, [tracks.length])

  // ── Maintain focusedTrackId invariant ──────────────────────────────────────
  // - Initialize to first track on project load
  // - Focus newly added track when list grew from empty
  // - Shift focus to previous track when focused track is deleted
  // - Drop to null when list becomes empty
  // Session-only: never serialized to project file.
  const prevTrackIdsRef = useRef([])
  useEffect(() => {
    const ids = tracks.map((t) => t.id)
    const prev = prevTrackIdsRef.current
    const current = focusedTrackIdRef.current

    if (ids.length === 0) {
      if (current !== null) setFocusedTrackId(null)
    } else if (current == null) {
      // Cold start, or recovering from empty list — focus first track
      setFocusedTrackId(ids[0])
    } else if (!ids.includes(current)) {
      // Focused track was removed — shift to previous in the prior order,
      // falling back forward, then to the first remaining track.
      const prevIdx = prev.indexOf(current)
      let next = null
      if (prevIdx > 0) {
        for (let i = prevIdx - 1; i >= 0; i--) {
          if (ids.includes(prev[i])) { next = prev[i]; break }
        }
      }
      if (next == null) {
        for (let i = prevIdx + 1; i < prev.length; i++) {
          if (ids.includes(prev[i])) { next = prev[i]; break }
        }
      }
      if (next == null) next = ids[0]
      setFocusedTrackId(next)
    }
    prevTrackIdsRef.current = ids
  }, [tracks, setFocusedTrackId])

  // ── Fetch waveform peaks for clip rendering (via WaveformMipmap) ─────────────
  useEffect(() => {
    if (Object.keys(regions).length === 0 || Object.keys(sources).length === 0) return

    let cancelled = false

    // LRU helpers
    function lruTouch(id) {
      const lru = waveformLruRef.current
      const idx = lru.indexOf(id)
      if (idx !== -1) lru.splice(idx, 1)
      lru.push(id)
    }
    function lruEvict() {
      const lru = waveformLruRef.current
      while (lru.length > WAVEFORM_CACHE_MAX) {
        const evictId = lru.shift()
        delete waveformCacheRef.current[evictId]
      }
    }

    async function fetchWaveforms() {
      const PEAKS_PER_SECOND = 200
      const MIN_PEAKS = 800
      const MAX_PEAKS = 16000

      for (const region of Object.values(regions)) {
        if (cancelled) break
        if (waveformCacheRef.current[region.id]) {
          lruTouch(region.id)
          continue
        }

        const source = sources[region.sourceId]
        if (!source?.filePath || region.startTime == null || region.endTime == null) continue

        try {
          // Swap-aware: extend fetch span past video range when swapped audio is longer.
          const durSec = getRegionPlaybackDurationSec(region)
          const peakWidth = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS,
            Math.round(durSec * PEAKS_PER_SECOND)))

          // Use mipmap-backed N-API binding (replaces 8kHz FFmpeg pipeline)
          const data = await window.xleth?.waveform?.getRegionPeaks(
            region.id, 0, durSec, peakWidth, -1
          )
          if (cancelled) break

          if (data && data.ready && data.peaks?.length > 0) {
            // Store in cache format compatible with timelineDrawing.js
            // peaks is [min,max,rms, min,max,rms, ...] — 3 values per column
            waveformCacheRef.current[region.id] = { peaks: data.peaks, stride: 3, peakWidth }
            // Remember engine sample rate for spp computation
            if (data.sampleRate) regionSampleRates.current[region.id] = data.sampleRate
            lruTouch(region.id)
            lruEvict()
            canvasRef.current?.redrawContent('waveform')
          } else if (data && !data.ready) {
            // Mipmap still generating — retry after a short delay
            setTimeout(() => {
              if (!cancelled) {
                delete waveformCacheRef.current[region.id]
                fetchWaveforms()
              }
            }, 150)
            return  // stop iterating, will retry all pending
          }
        } catch (e) {
          console.warn(`[Timeline] Waveform fetch failed for region ${region.id}:`, e.message)
        }
      }
    }

    fetchWaveforms()
    return () => { cancelled = true }
  }, [regions, sources])

  // ── Fetch waveform peaks for processed clips (stretch/pitch/reverse) ─────────
  // Runs whenever clips change. Fetches from ClipRenderCache via waveform_getClipPeaks.
  // Invalidates stale entries when a clip's processing params have changed.
  useEffect(() => {
    if (clips.length === 0) return
    let cancelled = false

    async function fetchClipPeaks() {
      const PEAKS_PER_SECOND = 200
      // Lower floor than the per-REGION fetch below deliberately. A region's
      // peak array is shared by every clip cut from it, so paying for 800
      // columns there is amortised; this array belongs to ONE clip, and
      // syllable-chopped projects routinely have clips well under 100 ms —
      // at an 800 floor that is >13,000 peaks/second, an array three times
      // larger than the clip can ever display, serialised through IPC per
      // clip. 256 still exceeds the ~2 columns/pixel the renderer will draw
      // (see decimatePeaks) at any zoom this fallback covers; past that the
      // viewport hi-res path takes over.
      const MIN_PEAKS = 256
      const MAX_PEAKS = 16000
      const bpm = bpmRef.current || 120

      for (const clip of clips) {
        if (cancelled) break

        const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                           || (clip.pitchOffsetCents ?? 0) !== 0
                           || clip.reversed
                           || ((clip.stretchRatio ?? 1.0) !== 1.0)
        if (!hasProcessing) {
          // Clip no longer processed — evict stale clip-peak entry
          if (clipPeakCacheRef.current[clip.id]) {
            delete clipPeakCacheRef.current[clip.id]
            delete hiResCacheRef.current[`c${clip.id}`]
          }
          continue
        }

        // Invalidate cache if params have changed since last fetch
        const cached = clipPeakCacheRef.current[clip.id]
        if (cached) {
          if (cached.pitchOffset      === (clip.pitchOffset ?? 0) &&
              cached.pitchOffsetCents === (clip.pitchOffsetCents ?? 0) &&
              cached.reversed         === !!clip.reversed &&
              cached.stretchRatio     === (clip.stretchRatio ?? 1.0) &&
              cached.regionOffsetTicks === (clip.regionOffsetTicks ?? 0) &&
              cached.syllableIndex    === (clip.syllableIndex ?? -1) &&
              cached.durationTicks     === clip.durationTicks) {
            continue  // still valid
          }
          // Params changed — evict and refetch, reset retry counter
          delete clipPeakCacheRef.current[clip.id]
          delete hiResCacheRef.current[`c${clip.id}`]
          clipPeakRetryRef.current[clip.id] = 0
        }

        const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
        if (clipDurSec <= 0) continue

        const peakWidth = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS,
          Math.round(clipDurSec * PEAKS_PER_SECOND)))

        try {
          const data = await window.xleth?.waveform?.getClipPeaks(
            clip.id, 0, clipDurSec, peakWidth)
          if (cancelled) break

          if (data?.ready && data.peaks?.length > 0) {
            clipPeakCacheRef.current[clip.id] = {
              peaks: data.peaks, stride: 3, peakWidth,
              pitchOffset:      clip.pitchOffset ?? 0,
              pitchOffsetCents: clip.pitchOffsetCents ?? 0,
              reversed:         !!clip.reversed,
              stretchRatio:     clip.stretchRatio ?? 1.0,
              regionOffsetTicks: clip.regionOffsetTicks ?? 0,
              syllableIndex:     clip.syllableIndex ?? -1,
              durationTicks:     clip.durationTicks,
            }
            canvasRef.current?.redrawContent('waveform')
          } else if (data && !data.ready) {
            // Cache miss — exponential backoff, max 4 retries (150→300→600→1200ms), then fall back
            const RETRY_DELAYS = [150, 300, 600, 1200]
            const retryCount = clipPeakRetryRef.current[clip.id] ?? 0
            if (retryCount < RETRY_DELAYS.length) {
              clipPeakRetryRef.current[clip.id] = retryCount + 1
              setTimeout(() => {
                if (!cancelled) {
                  delete clipPeakCacheRef.current[clip.id]
                  fetchClipPeaks()
                }
              }, RETRY_DELAYS[retryCount])
              return
            } else {
              // Max retries — fall back to raw region waveform and stop requesting
              console.warn(`[Timeline] Clip ${clip.id} cache not ready after ${RETRY_DELAYS.length} retries, falling back to region peaks`)
              clipPeakRetryRef.current[clip.id] = 0
              if (clip.regionId != null) {
                try {
                  const fallback = await window.xleth?.waveform?.getRegionPeaks(
                    clip.regionId, 0, clipDurSec, peakWidth, -1)
                  if (!cancelled && fallback?.ready && fallback.peaks?.length > 0) {
                    clipPeakCacheRef.current[clip.id] = {
                      peaks: fallback.peaks, stride: 3, peakWidth,
                      pitchOffset:      clip.pitchOffset ?? 0,
                      pitchOffsetCents: clip.pitchOffsetCents ?? 0,
                      reversed:         !!clip.reversed,
                      stretchRatio:     clip.stretchRatio ?? 1.0,
                      regionOffsetTicks: clip.regionOffsetTicks ?? 0,
                      syllableIndex:     clip.syllableIndex ?? -1,
                      durationTicks:     clip.durationTicks,
                    }
                    canvasRef.current?.redrawContent('waveform')
                  }
                } catch (fe) {
                  console.warn(`[Timeline] Fallback region peaks failed for clip ${clip.id}:`, fe.message)
                }
              }
            }
          }
        } catch (e) {
          console.warn(`[Timeline] Clip peak fetch failed for clip ${clip.id}:`, e.message)
        }
      }
    }

    fetchClipPeaks()
    return () => { cancelled = true }
  }, [clips])

  // ── Waveform cache invalidation (e.g. after swap/revert audio) ─────────────
  useEffect(() => {
    const handler = (e) => {
      const regionId = e.detail?.regionId
      if (regionId == null) return
      delete waveformCacheRef.current[regionId]
      delete hiResCacheRef.current[regionId]
      const lru = waveformLruRef.current
      const lruIdx = lru.indexOf(regionId)
      if (lruIdx !== -1) lru.splice(lruIdx, 1)
      // Drop the JS-side "already loaded" flag so rebuildAudioMappings re-runs
      // for this region and picks up the new swapped/original audio.
      loadedRegionAudioRef.current.delete(regionId)
      // Force waveform + audio remap effects to re-run by refetching regions.
      fetchRegions()
    }
    timelineEvents.addEventListener('timeline-waveform-invalidate', handler)
    return () => timelineEvents.removeEventListener('timeline-waveform-invalidate', handler)
  }, [fetchRegions])

  // ── Video cache invalidation (after swap/revert video) ─────────────────────
  // The engine already clears its own GPU frame cache on swap/revert (the
  // regenerated proxy reuses the same on-disk path, so stale decoded frames
  // could otherwise linger). Here we just refetch region state so the UI
  // picks up the new hasSwappedVideo/proxy metadata and any already-open
  // preview decoder for this region's proxy gets reopened against the fresh file.
  useEffect(() => {
    const handler = (e) => {
      const regionId = e.detail?.regionId
      if (regionId == null) return
      fetchRegions()
    }
    timelineEvents.addEventListener('timeline-video-invalidate', handler)
    return () => timelineEvents.removeEventListener('timeline-video-invalidate', handler)
  }, [fetchRegions])

  // ── ON-SETTLE: viewport-aware hi-res waveform fetch (for waveform-line &
  // sample regimes). Computes which clips are visible, determines the zoom
  // regime, and fetches viewport-appropriate data. The visible time window
  // shrinks as zoom increases, keeping data volume bounded by viewport pixel
  // width. Deps are the (now trailing-debounced) pixelsPerBeat/scrollOffset
  // state, so this no longer re-fires on every wheel tick — only once,
  // ~100ms after a zoom/scroll gesture stops. It must NOT run per-frame: an
  // IPC round-trip per wheel tick would stall the redraw path this whole
  // refactor exists to keep off the render/JS thread. The 80ms setTimeout
  // below is a separate, pre-existing debounce for the async fetch itself
  // (kept as-is — it also covers the clips/regions/canvasWidth deps, which
  // aren't part of the zoom/scroll hot path).
  useEffect(() => {
    // Gate: only relevant at zoom levels beyond envelope mode
    const ppb = pixelsPerBeatRef.current
    const bpm = bpmRef.current || 120
    const DEFAULT_SR = 48000
    const pixelsPerSecond = ppb * (bpm / 60)
    const spp = DEFAULT_SR / pixelsPerSecond
    // Same shared hysteresis-aware tracker drawClips uses — the fetcher and
    // the drawer MUST agree on the regime or the fetcher populates data the
    // drawer never reads. See waveformRegime.js.
    const regime = currentRegime(spp)

    if (regime === 'envelope') {
      // Clear any stale hi-res data when zoomed back out
      if (Object.keys(hiResCacheRef.current).length > 0) {
        hiResCacheRef.current = {}
      }
      // The not-ready stamps go with it: they only gate fetches that can't
      // happen in this regime anyway, and keeping them would make the first
      // pass after zooming back in skip clips for up to the backoff window.
      hiResNotReadyRef.current.clear()
      return
    }

    // Debounce: only fetch after scroll/zoom settles (80ms)
    if (hiResFetchTimer.current) clearTimeout(hiResFetchTimer.current)
    hiResFetchTimer.current = setTimeout(async () => {
      // Supersede any still-in-flight batch from a PREVIOUS settle (the old
      // code had no such guard — its cleanup only cleared the by-then-
      // already-fired setTimeout, so a fast pan-then-pan-again could run two
      // full fetch passes concurrently, doubling IPC traffic for a viewport
      // the user had already left). Every write below checks this before
      // touching the cache.
      const myGeneration = ++hiResFetchGenerationRef.current
      const scroll = scrollOffsetRef.current
      const w = canvasWidth || 800
      const pixelsPerSecond = ppb * (bpm / 60)
      const marginSec = HIRES_MARGIN_PX / pixelsPerSecond
      const mergeGapSec = HIRES_MERGE_GAP_PX / pixelsPerSecond
      // One clock read for the whole pass: every not-ready decision below must
      // compare against the same instant, or a long pass could let an early
      // clip through on a backoff a later clip is still inside.
      const nowMs = Date.now()
      pruneNotReady(hiResNotReadyRef.current, nowMs, HIRES_NOT_READY_MAX_AGE_MS)

      // ── Pass 1: classify every visible clip's need ──────────────────────
      // Unprocessed clips in trace/waveform regime are collected per-region
      // instead of fetched immediately — they're the case that used to cost
      // one serial IPC round-trip PER CLIP even when many clips on the same
      // region wanted the same or nearby windows (see hiResFetchPlanner.js).
      // Processed clips and sample-regime raw-sample requests stay per-clip
      // (a processed buffer belongs to exactly one clip; raw sample arrays
      // are large enough that merging scattered small requests would often
      // fetch far more data than any clip actually needs).
      const regionPeakRequests = new Map()   // regionId -> [{start,end}]
      const regionMaxSec = new Map()         // regionId -> region duration, for clamping
      const sampleJobs = []
      const processedJobs = []

      for (const clip of clips) {
        const region = regions[clip.regionId]
        if (!region) continue
        // Swap-aware: extend draw span past video range when swapped audio is longer.
        const regionDurSec = getRegionPlaybackDurationSec(region)
        if (regionDurSec <= 0) continue

        const beatPos = clip.positionTicks / PPQ
        const beatDur = clip.durationTicks / PPQ
        const x = (beatPos - scroll) * ppb
        const clipW = beatDur * ppb

        // Skip off-screen clips
        if (x + clipW < 0 || x > w) continue

        // Visible pixel range (clip ∩ viewport)
        const visL = Math.max(0, x)
        const visR = Math.min(w, x + clipW)
        if (visR <= visL) continue

        const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
        const regionOffsetSec = getClipRegionWaveformStartSec(clip, region, bpm)
        const secPerPx = clipDurSec / clipW
        const visStartSec = regionOffsetSec + (visL - x) * secPerPx
        const visEndSec   = regionOffsetSec + (visR - x) * secPerPx
        const sr = regionSampleRates.current[clip.regionId] || DEFAULT_SR

        const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                           || (clip.pitchOffsetCents ?? 0) !== 0
                           || clip.reversed
                           || ((clip.stretchRatio ?? 1.0) !== 1.0)

        if (hasProcessing && regime !== 'sample') {
          // Processed clip: use clip-local time coords (0 = start of processed buffer).
          // Keyed by "c"+clipId so multiple clips on the same region don't collide.
          //
          // Padded by the same margin the region path uses. Unpadded, a clip
          // straddling a viewport edge cached EXACTLY its visible sub-range,
          // so the next settle after any pan found it uncovered and refetched
          // unconditionally — see hiResProcessedPlanner.js.
          const { start: clipLocalStart, end: clipLocalEnd } = padClipWindow(
            (visL - x) * secPerPx, (visR - x) * secPerPx, marginSec, clipDurSec)
          const hiResKey = `c${clip.id}`
          const cachedClip = hiResCacheRef.current[hiResKey]
          if (cachedClip?.peaks && hiResCoversWindow(cachedClip.startSec, cachedClip.endSec, clipLocalStart, clipLocalEnd)) continue
          // The engine had no rendered buffer for this clip recently — don't
          // re-ask every 80ms settle. It gets another chance after the backoff.
          if (!shouldRetryNotReady(hiResNotReadyRef.current.get(hiResKey), nowMs, HIRES_NOT_READY_BACKOFF_MS)) continue
          // secPerPx is clip-local seconds per PIXEL, so its reciprocal sizes
          // the padded window in pixels — the padded window is wider than the
          // visible one and must be sampled at matching resolution, or the
          // extra margin would cost resolution inside the visible part.
          const pxWidth = Math.ceil((clipLocalEnd - clipLocalStart) / secPerPx)
          processedJobs.push({
            clipId: clip.id, hiResKey, clipLocalStart, clipLocalEnd,
            visPxWidth: Math.max(1, pxWidth),
            centreDistPx: Math.abs((visL + visR) / 2 - w / 2),
          })
          continue
        }

        if (regime === 'sample') {
          sampleJobs.push({ regionId: clip.regionId, visStartSec, visEndSec, sr })
          continue
        }

        // Unprocessed, trace/waveform regime → collect for per-region coalescing.
        const list = regionPeakRequests.get(clip.regionId) || []
        list.push({ start: visStartSec, end: visEndSec })
        regionPeakRequests.set(clip.regionId, list)
        if (!regionMaxSec.has(clip.regionId)) regionMaxSec.set(clip.regionId, regionDurSec)
      }

      // ── Pass 2: plan merged peak fetches per region ─────────────────────
      const peakFetchJobs = []  // { regionId, start, end }
      for (const [regionId, requests] of regionPeakRequests) {
        const existing = hiResCacheRef.current[regionId] || []
        const planned = planRegionFetches(requests, existing, {
          marginSec, mergeGapSec,
          maxSec: regionMaxSec.get(regionId),
          maxFetches: HIRES_MAX_FETCHES_PER_REGION,
        })
        for (const win of planned) peakFetchJobs.push({ regionId, start: win.start, end: win.end })
      }

      // ── Pass 2b: cap processed-clip fetches, viewport-centre first ───────
      // Merging is genuinely inapplicable here (no two clips share a processed
      // buffer), but a cap is not — and without one a stretch-heavy viewport
      // issued one fetch per visible processed clip (118 on BFDIA 9), every
      // one of them ahead of the user's next paste/transport RPC in the engine
      // worker's single-threaded queue. See hiResProcessedPlanner.js.
      const cappedProcessedJobs = prioritiseProcessedJobs(processedJobs, HIRES_MAX_PROCESSED_FETCHES)

      // ── Pass 3: dedupe sample-regime jobs (no merging — see above) ──────
      const dedupedSampleJobs = []
      const plannedSampleWindows = new Map() // regionId -> [{start,end}] already queued this pass
      for (const job of sampleJobs) {
        const existing = hiResCacheRef.current[job.regionId] || []
        if (findCoveringEntry(existing, job.visStartSec, job.visEndSec)) continue
        const already = plannedSampleWindows.get(job.regionId) || []
        if (already.some((win) => hiResCoversWindow(win.start, win.end, job.visStartSec, job.visEndSec))) continue
        already.push({ start: job.visStartSec, end: job.visEndSec })
        plannedSampleWindows.set(job.regionId, already)
        dedupedSampleJobs.push(job)
      }

      // ── Pass 4: dispatch everything concurrently ─────────────────────────
      // Concurrent, not serial-awaited: the old for-loop awaited one clip's
      // IPC round-trip before even STARTING the next, so N visible clips on
      // a busy region meant N round-trips stacked end to end. Each job below
      // re-reads hiResCacheRef.current[key] fresh AFTER its own await and
      // writes immediately after (no further await in between) — that keeps
      // the read-modify-write atomic relative to every other concurrently
      // resolving job, so two jobs landing for the same region never lose
      // one another's insert.
      const tasks = []

      for (const job of peakFetchJobs) {
        tasks.push((async () => {
          try {
            const targetPixels = Math.max(1, Math.round((job.end - job.start) * pixelsPerSecond))
            const data = await window.xleth?.waveform?.getRegionPeaks(
              job.regionId, job.start, job.end, targetPixels, -1)
            if (hiResFetchGenerationRef.current !== myGeneration) return
            if (data?.ready && data.peaks?.length > 0) {
              const existing = hiResCacheRef.current[job.regionId] || []
              hiResCacheRef.current[job.regionId] = insertEntry(existing, {
                peaks: data.peaks,
                stride: 3,
                startSec: job.start,
                endSec: job.end,
                sampleRate: data.sampleRate || (regionSampleRates.current[job.regionId] || DEFAULT_SR),
              }, HIRES_MAX_ENTRIES_PER_REGION)
              hiResRedrawRef.current?.request()
            }
          } catch (e) {
            console.warn(`[Timeline] Hi-res fetch failed for region ${job.regionId}:`, e.message)
          }
        })())
      }

      for (const job of dedupedSampleJobs) {
        tasks.push((async () => {
          try {
            const startSample = Math.floor(job.visStartSec * job.sr)
            const endSample   = Math.ceil(job.visEndSec * job.sr)
            const data = await window.xleth?.waveform?.getRawSamples(
              job.regionId, startSample, endSample, -1)
            if (hiResFetchGenerationRef.current !== myGeneration) return
            if (data?.samples?.length > 0) {
              const existing = hiResCacheRef.current[job.regionId] || []
              hiResCacheRef.current[job.regionId] = insertEntry(existing, {
                samples: data.samples,
                startSample,
                endSample,
                startSec: job.visStartSec,
                endSec: job.visEndSec,
                sampleRate: data.sampleRate || job.sr,
              }, HIRES_MAX_ENTRIES_PER_REGION)
              hiResRedrawRef.current?.request()
            }
          } catch (e) {
            console.warn(`[Timeline] Hi-res raw-sample fetch failed for region ${job.regionId}:`, e.message)
          }
        })())
      }

      for (const job of cappedProcessedJobs) {
        tasks.push((async () => {
          try {
            const data = await window.xleth?.waveform?.getClipPeaks(
              job.clipId, job.clipLocalStart, job.clipLocalEnd, job.visPxWidth)
            if (hiResFetchGenerationRef.current !== myGeneration) return
            if (data?.ready && data.peaks?.length > 0) {
              hiResCacheRef.current[job.hiResKey] = {
                peaks: data.peaks,
                stride: 3,
                startSec: job.clipLocalStart,
                endSec:   job.clipLocalEnd,
              }
              hiResNotReadyRef.current.delete(job.hiResKey)
              hiResRedrawRef.current?.request()
            } else {
              // ready:false = ClipRenderCache miss (buffer building, or GC'd
              // when its last subscriber left). Stamp it so the next settle
              // passes skip it instead of re-asking every 80ms forever.
              hiResNotReadyRef.current.set(job.hiResKey, Date.now())
            }
          } catch (e) {
            console.warn(`[Timeline] Hi-res clip peak fetch failed for clip ${job.clipId}:`, e.message)
          }
        })())
      }

      await Promise.allSettled(tasks)
    }, 80)

    return () => {
      if (hiResFetchTimer.current) clearTimeout(hiResFetchTimer.current)
    }
  }, [pixelsPerBeat, scrollOffset, clips, regions, canvasWidth])

  // ── Transport polling (control state only — position comes from PlayheadClock)

  useEffect(() => subscribe((s) => {
    bpmRef.current = s.bpm

    if (s.isPlaying !== isPlayingRef.current) {
      isPlayingRef.current = s.isPlaying
      if (!s.isPlaying) {
        // Final position at engine-reported stopped position
        const stopBeat = Number.isFinite(s.rawPositionBeats)
          ? s.rawPositionBeats
          : s.positionMs * s.bpm / 60000
        playheadBeatRef.current = stopBeat
        editCursor.setPosition(stopBeat)
        canvasRef.current?.positionPlayhead(stopBeat)
        rulerRef.current?.redrawOverlay()
      }
    }
  }), [])

  // FXG.4-h — drive parent-attached macro automation lanes at control rate. The
  // controller subscribes to the same transport poller and evaluates each graph-mode
  // track's macro automation at the current tick, then drives the macro's connected
  // parameter edges. Mounted once for the app session; no audio-thread work.
  useEffect(() => startMacroAutomationPlayback(), [])

  // Envelope-to-parameter modulation has NO renderer drive. The Envelope Controller
  // is evaluated in the engine, on the audio thread, against the authoritative
  // transport position — see engine/src/model/EnvelopeParameterModulation.h and
  // MixEngine::refreshEnvelopeDefinitions. The renderer's only remaining job is to
  // persist the definition in graphState, which timeline.setTrackGraphState already
  // does. Do not add a second evaluator here: two evaluators can disagree, and the
  // renderer's could only ever be an estimate of the clock the engine owns.

  // ── PlayheadClock 60fps auto-scroll ─────────────────────────────────────────
  // Playhead drawing is handled by TimelineCanvas and TimelineRuler directly.

  // During playback, editCursor follows the playback position (10fps, no re-renders).
  // When stopped, editCursor is authoritative and won't be overwritten.
  useEffect(() => {
    return playheadClock.onDisplayUpdate((posMs, bpm, positionBeats) => {
      if (!isPlayingRef.current) return
      editCursor.setPosition(Number.isFinite(positionBeats)
        ? positionBeats
        : (posMs / 1000) * (bpm / 60))
    })
  }, [])

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs, bpm, positionBeats) => {
      playheadBeatRef.current = Number.isFinite(positionBeats)
        ? positionBeats
        : posMs * bpmRef.current / 60000

      // Opt-in only (Auto Scroll toggle in TransportBar), and only while
      // actually playing. Off by default — the timeline never moves itself.
      if (!isFollowLocked()) return
      const el = canvasAreaRef.current
      if (!el) return
      const w = el.getBoundingClientRect().width
      const animator = viewAnimatorRef.current
      const ppb = animator?.getCurrent('ppb') || pixelsPerBeatRef.current
      const visibleBeats = w / ppb
      // Center the playhead every frame — it's the centerpiece the view
      // follows continuously, not an edge-triggered catch-up. Manual
      // horizontal scroll/pan is locked out while this is active (see the
      // wheel/pan/scrollbar handlers below), so there's no fight to guard
      // against here.
      const nextScroll = Math.max(
        0,
        Math.min(maxScrollRef.current, playheadBeatRef.current - visibleBeats / 2),
      )
      // Keeping the playhead centered outranks a still-easing zoom's cursor
      // anchor — same anchor-release as the manual scroll paths.
      zoomAnchorRef.current = null
      animator?.setTarget('scrollX', nextScroll)
    })
    return unsub
  }, [maxScrollRef, isFollowLocked])

  useEffect(() => {
    function handleThemeChange() {
      canvasRef.current?.redrawGrid('theme')
      canvasRef.current?.redrawContent('theme')
      rulerRef.current?.redraw()
    }
    window.addEventListener('xleth-theme-changed', handleThemeChange)
    return () => window.removeEventListener('xleth-theme-changed', handleThemeChange)
  }, [])

  // Dev-only console bridge to TimelineCanvas.getDrawStats() — lets us pull
  // redrawContent() p50/p95/max from devtools while sizing the per-frame
  // budget, without wiring a permanent debug UI.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__xlethTimelineDebug = {
      getDrawStats: () => canvasRef.current?.getDrawStats(),
      getView: () => ({
        ppb: pixelsPerBeatRef.current,
        scrollX: scrollOffsetRef.current,
        maxScroll: maxScrollRef.current,
        targetPpb: viewAnimatorRef.current?.getTarget('ppb'),
        targetScrollX: viewAnimatorRef.current?.getTarget('scrollX'),
        anchor: zoomAnchorRef.current,
      }),
    }
    return () => { delete window.__xlethTimelineDebug }
  }, [])

  // Dev-only: window.__xlethLensDev sets a per-note Lens override through the
  // real editPatternNotes path (Lens + Roam P5 plumbing check; no UI until P8).
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined
    return installNoteLensDevHook(window)
  }, [])

  // ── PER-FRAME: grid/ruler/content redraw + playhead reposition on zoom or
  // scroll. This used to live in two useEffects keyed on [pixelsPerBeat] /
  // [scrollOffset] state, which meant every wheel tick forced a React
  // render just to reach this code. It now runs directly out of
  // commitViewportRedraw(), called synchronously from applyZoom/applyScroll's
  // onCommit (see the hook instantiation above) — no render involved.

  // ── ON-SETTLE: the console diagnostic below is the only thing left that
  // actually wants the debounced state — it fires once, ~100ms after the
  // zoom gesture stops, instead of spamming the console every tick.
  useEffect(() => {
    const barsVisible = (canvasAreaRef.current?.getBoundingClientRect().width || 800) / pixelsPerBeat / BEATS_PER_BAR
    console.log(`[Timeline] Zoom: ${pixelsPerBeat.toFixed(1)}px/beat, ~${barsVisible.toFixed(1)} bars visible`)
  }, [pixelsPerBeat])

  // ── Redraw content layer when clips/regions/selection change ───────────────
  // These are "the data changed" notifications, so they REQUEST a repaint
  // rather than doing one each: a single commit often trips several of them
  // (an edit that changes clips and selection, a project load that changes
  // everything), and the canvas coalesces the requests into one repaint before
  // the browser paints. See TimelineCanvas requestContentRedraw.

  useEffect(() => {
    canvasRef.current?.requestContentRedraw('clips')
  }, [clips, regions, tracks])

  // Grid needs a redraw when tracks/regions change because Pattern-track rows
  // get a tint based on the assigned region's label color.
  useEffect(() => {
    canvasRef.current?.requestGridRedraw('tracks-or-regions')
  }, [tracks, regions])

  useEffect(() => {
    canvasRef.current?.requestContentRedraw('pattern-blocks')
  }, [patternBlocks, patterns])

  useEffect(() => {
    canvasRef.current?.requestContentRedraw('selection')
  }, [selectedClipIds, selectedBlockIds, selectedAutomationClipIds])

  useEffect(() => {
    canvasRef.current?.requestContentRedraw('automation-clips')
  }, [automationClips, automationEnvelopes, automationBindingLabels, selectedAutomationPoint])

  useEffect(() => {
    canvasRef.current?.requestContentRedraw('display-settings')
  }, [timelineDisplaySettings])

  // ── Total song length (independent of container width) ────────────────────
  // Derived from the longest clip/pattern-block end + 64 bars of padding,
  // floored at 512 bars. This decouples horizontal scroll range from layout.
  const songEndBeats = useMemo(
    () => contentEndBeats([clips, patternBlocks, automationClips]),
    [clips, patternBlocks, automationClips],
  )
  const totalBeats = useMemo(() => {
    const minBeats = 512 * BEATS_PER_BAR // 2048 beats (512 bars)
    const padBeats = 64 * BEATS_PER_BAR  // 64 bars trailing room
    return Math.max(minBeats, songEndBeats + padBeats)
  }, [songEndBeats])

  // ── Zoom-out limit: the whole song fits the canvas ───────────────────────
  // See timeline/zoomFit.js. Both inputs are independent of the zoom level,
  // so zooming can never move its own limit (no clamp↔fit feedback loop).
  const fitBeats = useMemo(() => fitBeatsFor(songEndBeats), [songEndBeats])
  const minPpb = useMemo(() => minPpbFor(canvasWidth, fitBeats), [canvasWidth, fitBeats])

  // The ONE scroll-bound formula every path uses (per-frame zoom commit, the
  // settle effect below, and the scrollbar's extent), so they can't disagree.
  const scrollBoundFor = useCallback((ppb) => maxScrollFor({
    ppb, canvasWidth, workspaceBeats: totalBeats, fitBeats, minPpb,
  }), [canvasWidth, totalBeats, fitBeats, minPpb])

  // ── ON-SETTLE: max scroll bound (total length minus the currently visible
  // window). setMaxScroll is a plain ref write (no re-render), so this is
  // cheap, and it only needs to be correct within the ~100ms settle window —
  // it clamps the *edges* of scroll, it draws nothing, so a few stale ms
  // mid-gesture never shows up as a visual artifact. This effect is the
  // general-purpose recompute (also covers canvasWidth/totalBeats changing
  // on their own); the zoom hook's onCommit above additionally recomputes
  // it PER-FRAME during an active zoom so the view animator's cursor-
  // anchored scroll math is never clipped by a stale bound mid-gesture.
  useEffect(() => {
    // The live ref, not the debounced state: this also runs when the song or
    // canvas changes mid-gesture, and must bound the zoom actually on screen.
    const bound = scrollBoundFor(pixelsPerBeatRef.current)
    setMaxScroll(bound)
    // A shrunk bound (content deleted, panel widened) must pull the view back
    // in now — not leave it parked out of range until the next scroll input.
    if (scrollOffsetRef.current > bound) {
      const clamped = applyScroll(bound)
      viewAnimatorRef.current?.setCurrent('scrollX', clamped)
    }
  }, [scrollBoundFor, pixelsPerBeat, setMaxScroll, applyScroll, pixelsPerBeatRef, scrollOffsetRef])

  // Publish the zoom-out limit. If the view was sitting at the old limit
  // (fully zoomed out) it stays fitted: resizing the panel or adding a clip
  // past the end keeps the whole song on screen. A view zoomed in past a
  // limit that just rose (clips removed, panel widened) is pulled up to it.
  const prevMinPpbRef = useRef(null)
  useEffect(() => {
    const prevMin = prevMinPpbRef.current
    prevMinPpbRef.current = minPpb
    setMinPpb(minPpb)
    const animator = viewAnimatorRef.current
    if (!animator) return
    const target = animator.getTarget('ppb')
    const wasFitted = prevMin != null && target <= prevMin * (1 + 1e-6)
    if (wasFitted || target < minPpb) {
      zoomAnchorRef.current = null
      animator.setTarget('ppb', minPpb, { immediate: true })
    }
  }, [minPpb, setMinPpb])

  // ── Track canvas area width for scrollbar ──────────────────────────────────

  useEffect(() => {
    const el = canvasAreaRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0) setCanvasWidth(w)
    })
    setCanvasWidth(el.clientWidth || 800)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tracks.length > 0])

  useOnVisibilityChange((isVisible) => {
    if (!isVisible) return
    // Re-show kick: display:none leaves ResizeObserver flaky and
    // canvas dimensions stale. Read clientWidth synchronously
    // and force imperative redraws at the now-correct layout.
    const el = canvasAreaRef.current
    if (el) {
      const w = el.clientWidth || 800
      if (w > 0) setCanvasWidth(w)
    }
    canvasRef.current?.redrawGrid('visibility')
    canvasRef.current?.redrawContent('visibility')
    motionViewRef.current?.redraw()
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
  })

  // ── Wheel handler (shared between ruler and canvas) ────────────────────────

  // Wheel on canvas/ruler:
  //   Ctrl+wheel  = horizontal zoom (cursor-centered)
  //   Alt+wheel   = vertical zoom (cursor-centered)
  //   Shift+wheel = horizontal scroll
  //   plain wheel = vertical track scroll
  const handleWheel = useCallback((e) => {
    const motionShown = timelineViewNameRef.current === 'motion'
    if (e.altKey && motionShown) {
      // Motion view: Alt+wheel is ITS track row height (per view, R19).
      e.preventDefault()
      motionViewRef.current?.zoomRowHeight(e)
      return
    }
    if (e.altKey) {
      e.preventDefault()
      const sc = scrollContainerRef.current
      if (!sc || e.deltaY === 0) return

      const nextHeight = zoomTrackHeight(trackHeight, e.deltaY)
      if (nextHeight === trackHeight) return

      const rect = sc.getBoundingClientRect()
      const localY = Math.max(0, Math.min(sc.clientHeight, e.clientY - rect.top))
      const contentY = sc.scrollTop + localY
      const scale = nextHeight / trackHeight

      setTimelineTrackHeight(nextHeight)
      setTrackHeight(nextHeight)
      requestAnimationFrame(() => {
        const current = scrollContainerRef.current
        if (!current) return
        const maxScrollTop = Math.max(0, current.scrollHeight - current.clientHeight)
        current.scrollTop = Math.max(0, Math.min(maxScrollTop, contentY * scale - localY))
      })
      return
    }
    if (e.ctrlKey) {
      e.preventDefault()
      const rect = canvasAreaRef.current?.getBoundingClientRect()
      if (!rect) return
      const animator = viewAnimatorRef.current
      const steps = wheelZoomSteps(e.deltaY, e.deltaMode)
      // Compound from the TARGET — a burst of same-direction wheel notches
      // should land N steps from where we're already heading, not stall at
      // wherever the spring has caught up to so far.
      const target = animator.getTarget('ppb')
      const nextPpb = Math.max(minPpbRef.current, Math.min(MAX_PPB, target * ZOOM_FACTOR ** steps))
      // Pinned at a zoom limit: nothing to do. Re-anchoring here would only
      // wake the animator to re-derive the scroll it already has.
      if (nextPpb === target) return
      const cursorPixelX = e.clientX - rect.left
      // Anchor from the CURRENT (already-rendered) position, not the
      // target — the user is reacting to what's on screen right now.
      const cursorBeat = pixelToBeat(cursorPixelX, animator.getCurrent('scrollX'), animator.getCurrent('ppb'))
      zoomAnchorRef.current = { beat: cursorBeat, pixelX: cursorPixelX }
      animator.setTarget('ppb', nextPpb)
      return
    }
    if (e.shiftKey || e.deltaX !== 0) {
      e.preventDefault()
      // Auto Scroll owns horizontal position while it's actively following
      // playback — resize (the ctrl+wheel branch above) still works.
      if (isFollowLocked()) return
      // Release a still-easing zoom's cursor anchor — otherwise onTick keeps
      // re-imposing the anchor-computed scrollX every frame, fighting this
      // scroll input frame-by-frame (reads as jitter/tug-of-war) for as long
      // as the zoom is still in flight.
      zoomAnchorRef.current = null
      const animator = viewAnimatorRef.current
      const dy = e.shiftKey ? e.deltaY : 0
      const delta = ((dy + e.deltaX) / (animator.getCurrent('ppb') || 40)) * 0.8
      const nextScroll = Math.max(0, Math.min(maxScrollRef.current, animator.getTarget('scrollX') + delta))
      animator.setTarget('scrollX', nextScroll)
      return
    }
    // Plain wheel → vertical scroll on the canvas-scroll wrapper. Direct
    // 1:1 write (like the native overflow-scroll on the header column),
    // not an eased spring — a spring here reads as sluggish/decelerating
    // deceleration compared to the header side, which just scrolls at
    // native speed. Each view scrolls its own rows.
    const sc = motionShown ? motionViewRef.current?.scroller() : scrollContainerRef.current
    if (sc && sc.scrollHeight > sc.clientHeight) {
      e.preventDefault()
      const maxScrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight)
      const nextScrollTop = Math.max(0, Math.min(maxScrollTop, sc.scrollTop + e.deltaY))
      sc.scrollTop = nextScrollTop
      viewAnimatorRef.current?.setCurrent('scrollY', nextScrollTop)
    }
  }, [trackHeight, maxScrollRef, minPpbRef, isFollowLocked])

  const handleMiddleMousePan = useCallback((deltaXPx, deltaYPx) => {
    const followLocked = isFollowLocked()
    const { deltaBeats, deltaScrollTop } = pixelsToViewportPan(
      deltaXPx,
      deltaYPx,
      pixelsPerBeatRef.current,
    )
    // Direct 1:1 drag, not eased — spring lag on an actively-held pan gesture
    // would read as the view fighting the mouse. Sync the spring's own
    // bookkeeping to match so a wheel gesture starting right after this pan
    // ends eases from the real position instead of jumping to a stale one.
    // Auto Scroll owns horizontal position while it's actively following
    // playback — vertical (track list) panning below is unaffected.
    if (!followLocked && deltaBeats !== 0) {
      // Same anchor-release as the wheel-scroll branch: a still-easing zoom
      // must not fight this drag frame-by-frame.
      zoomAnchorRef.current = null
      const clamped = scrollBy(deltaBeats)
      viewAnimatorRef.current?.setCurrent('scrollX', clamped)
    }

    const sc = scrollContainerRef.current
    if (!sc || deltaScrollTop === 0 || sc.scrollHeight <= sc.clientHeight) return
    const maxScrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight)
    sc.scrollTop = Math.max(0, Math.min(maxScrollTop, sc.scrollTop + deltaScrollTop))
  }, [scrollBy, isFollowLocked])

  // ── Track mutations ────────────────────────────────────────────────────────

  const notifyTrackLayoutChanged = useCallback(() => {
    timelineEvents.dispatchEvent(new Event('timeline-track-layout-changed'))
    timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
  }, [])

  const handleSelectTrack = useCallback((trackId, event) => {
    const visibleIds = visibleTracks.map(track => track.id)
    setSelectedTrackIds(previous => {
      const result = updateTrackSelection({
        selectedTrackIds: previous,
        visibleTrackIds: visibleIds,
        trackId,
        anchorTrackId: trackSelectionAnchorRef.current,
        toggle: event?.ctrlKey || event?.metaKey,
        range: event?.shiftKey,
      })
      trackSelectionAnchorRef.current = result.anchorTrackId
      return result.selectedTrackIds
    })
  }, [visibleTracks])

  const handleOpenTrackInMixer = useCallback((trackId) => {
    setFocusedTrackId(trackId)
    usePanelRegistry.getState().openPanel('mixer')
  }, [setFocusedTrackId])

  const handleAddFolder = useCallback(async () => {
    const timeline = window.xleth?.timeline
    if (!timeline?.createTrackFolder) return
    const selectedInOrder = tracks.map(track => track.id).filter(id => selectedTrackIds.has(id))
    const name = nextFolderName(normalizedFolderLayout.folders)
    const rootIndex = selectedInOrder.length > 0
      ? rootIndexForSelectedTracks(normalizedFolderLayout, selectedTrackIds)
      : normalizedFolderLayout.rootOrder.length
    try {
      const folderId = await timeline.createTrackFolder({ name, trackIds: selectedInOrder, rootIndex })
      if (folderId == null || folderId < 0) throw new Error('Folder creation rejected')
      setSelectedTrackIds(new Set())
      setEditingFolderId(folderId)
      await fetchTracks()
      notifyTrackLayoutChanged()
    } catch (error) {
      console.warn('[Timeline] createTrackFolder failed', error)
    }
  }, [fetchTracks, normalizedFolderLayout, notifyTrackLayoutChanged, selectedTrackIds, tracks])

  const commitFolderLayout = useCallback(async (nextLayout) => {
    setFolderLayout(nextLayout)
    useMixerStore.getState().syncFromTimeline(tracks, nextLayout)
    try {
      const ok = await window.xleth?.timeline?.setTrackLayout?.(nextLayout)
      if (ok === false) throw new Error('Layout rejected')
      notifyTrackLayoutChanged()
    } catch (error) {
      console.warn('[Timeline] setTrackLayout failed', error)
      await fetchTracks()
    }
  }, [fetchTracks, notifyTrackLayoutChanged, tracks])

  const handleMoveFolderTracks = useCallback((trackIds, target) => {
    commitFolderLayout(moveTracksInLayout(normalizedFolderLayout, trackIds, target))
  }, [commitFolderLayout, normalizedFolderLayout])

  const handleMoveFolder = useCallback((folderId, targetRootIndex) => {
    commitFolderLayout(moveFolderInLayout(normalizedFolderLayout, folderId, targetRootIndex))
  }, [commitFolderLayout, normalizedFolderLayout])

  const handleToggleFolder = useCallback(async (folderId, collapsed) => {
    try {
      const ok = await window.xleth?.timeline?.setTrackFolderCollapsed?.(folderId, collapsed)
      if (ok === false) throw new Error('Collapse rejected')
      await fetchTracks()
      notifyTrackLayoutChanged()
    } catch (error) {
      console.warn('[Timeline] setTrackFolderCollapsed failed', error)
    }
  }, [fetchTracks, notifyTrackLayoutChanged])

  const handleRenameFolder = useCallback(async (folderId, name) => {
    try {
      const ok = await window.xleth?.timeline?.setTrackFolderName?.(folderId, name)
      if (ok === false) throw new Error('Rename rejected')
      await fetchTracks()
      notifyTrackLayoutChanged()
    } catch (error) {
      console.warn('[Timeline] setTrackFolderName failed', error)
    }
  }, [fetchTracks, notifyTrackLayoutChanged])

  const handleRemoveFolder = useCallback(async (folderId) => {
    try {
      const ok = await window.xleth?.timeline?.removeTrackFolder?.(folderId)
      if (ok === false) throw new Error('Folder removal rejected')
      await fetchTracks()
      notifyTrackLayoutChanged()
    } catch (error) {
      console.warn('[Timeline] removeTrackFolder failed', error)
    }
  }, [fetchTracks, notifyTrackLayoutChanged])

  // "+" button opens a small type picker (Clip vs Pattern) instead of always
  // defaulting to a Clip track that then needs a manual convert.
  const handleAddTrackClick = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setAddTrackMenu({ x: rect.left, y: rect.bottom + 2 })
  }, [])

  const handleMute = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.muted
    if (window.xleth?.timeline?.setTrackMuted) {
      try {
        await window.xleth.timeline.setTrackMuted(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, muted: next } : t))
    )
  }, [tracks, fetchTracks])

  const handleSolo = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.solo
    if (window.xleth?.timeline?.setTrackSolo) {
      try {
        await window.xleth.timeline.setTrackSolo(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, solo: next } : t))
    )
  }, [tracks, fetchTracks])

  // The output pearl (ui-kit/pearlRules.ts): click = on/off, right-click = solo, right-click the
  // only lit track = everything back on. Works on the mute flags; any legacy solo flag is cleared
  // in the same action so what is lit is what is heard.
  const handlePearl = useCallback(async (id, action) => {
    // Clones make no sound and their mute only hides their video, so they are
    // not part of what is heard: soloing a source must not hide its Clones.
    const heard = tracks.filter((t) => !isClone(t))
    const changes = pearlPlan(heard.map((t) => ({ id: t.id, muted: !!t.muted, soloed: !!t.solo })), id, action)
    if (changes.length === 0) return
    const tl = window.xleth?.timeline
    if (tl?.setTrackMuted) {
      try {
        for (const c of changes) {
          if (c.clearSolo && tl.setTrackSolo) await tl.setTrackSolo(c.id, false)
          if (c.muted !== undefined) await tl.setTrackMuted(c.id, c.muted)
        }
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) => prev.map((t) => {
      const c = changes.find((x) => x.id === t.id)
      return c ? { ...t, muted: c.muted ?? t.muted, solo: c.clearSolo ? false : t.solo } : t
    }))
  }, [tracks, fetchTracks])

  const handleVisualOnly = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.visualOnly
    if (window.xleth?.timeline?.setTrackVisualOnly) {
      try {
        await window.xleth.timeline.setTrackVisualOnly(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, visualOnly: next } : t))
    )
  }, [tracks, fetchTracks])

  // Pass 6D + 6F — centralized track color assignment. Sanitizes input
  // UI-side, then delegates to the engine command (undo/redo-safe). With no
  // engine available, mutates local state so dev fixtures and standalone
  // harnesses can exercise the resolver. Pass 6E added the Auto/paletteSlot
  // picker; Pass 6F adds the custom-hex code path (no UI yet — exposed in 6G).
  const handleSetTrackColor = useCallback(async (id, assignment) => {
    const rawMode = assignment?.mode
    let mode = 'auto'
    let slot = 0
    let customColor = ''

    if (rawMode === 'paletteSlot') {
      const n = typeof assignment?.slot === 'number' ? Math.trunc(assignment.slot) : NaN
      if (Number.isFinite(n) && n >= 1 && n <= 16) { mode = 'paletteSlot'; slot = n }
    } else if (rawMode === 'custom') {
      const normalized = normalizeTrackCustomColor(assignment?.customColor)
      if (normalized) { mode = 'custom'; customColor = normalized }
    }

    let sanitized
    if (mode === 'paletteSlot')      sanitized = { mode: 'paletteSlot', slot }
    else if (mode === 'custom')      sanitized = { mode: 'custom', customColor }
    else                              sanitized = { mode: 'auto' }

    if (window.xleth?.timeline?.setTrackColor) {
      try {
        await window.xleth.timeline.setTrackColor(id, sanitized)
        await fetchTracks()
        return
      } catch (e) {
        console.warn('[Timeline] setTrackColor failed', e)
      }
    }
    setTracks((prev) => prev.map((t) => {
      if (t.id !== id) return t
      if (sanitized.mode === 'paletteSlot') {
        const { trackColorCustom: _c, ...rest } = t
        return { ...rest, trackColorMode: 'paletteSlot', trackColorSlot: sanitized.slot }
      }
      if (sanitized.mode === 'custom') {
        const { trackColorSlot: _s, ...rest } = t
        return { ...rest, trackColorMode: 'custom', trackColorCustom: sanitized.customColor }
      }
      const { trackColorSlot: _s, trackColorCustom: _c, ...rest } = t
      return { ...rest, trackColorMode: 'auto' }
    }))
  }, [fetchTracks])

  const handleRename = useCallback(async (id, name) => {
    // Persist to engine first so undo/redo and project save see the change.
    if (window.xleth?.timeline?.setTrackName) {
      try {
        await window.xleth.timeline.setTrackName(id, name)
      } catch (e) {
        console.warn('[Timeline] setTrackName failed', e)
      }
    }
    setTracks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, name } : t))
      useMixerStore.getState().syncFromTimeline(next)
      return next
    })
    console.log(`[Timeline] Track ${id} renamed to "${name}"`)
  }, [])

  const handlePatternRename = useCallback(async (id, name) => {
    if (window.xleth?.timeline?.setPatternName) {
      try {
        await window.xleth.timeline.setPatternName(id, name)
      } catch (e) {
        console.warn('[Timeline] setPatternName failed', e)
      }
    }
    setPatterns((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], name } } : prev))
    // Notify other views (App.jsx keeps its own pattern cache for the Piano
    // Roll title/dropdown).
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    console.log(`[Timeline] Pattern ${id} renamed to "${name}"`)
  }, [])

  const handleRemove = useCallback(async (id) => {
    // Deletion contract (Phase C): removing a track takes its chain — and any
    // automation clip bound to an effect on that chain — with it, so the same
    // confirmation cascades here. Cancelling aborts the whole removal.
    try {
      const { confirmTrackRemoval } = await import('./mixer/automationDeletionGuard.js')
      const track = tracks.find((t) => t.id === id)
      // A source's Clones go with it in the same undo step (engine); the
      // confirmation, when there is one, names them too.
      const proceed = await confirmTrackRemoval(id, track?.name, { subject: trackRemovalSubject(track, tracks) })
      if (!proceed) return
    } catch (e) {
      console.warn('[Timeline] automation deletion guard failed:', e?.message)
    }
    console.log(`[Timeline] Track ${id} removed`)
    if (window.xleth?.timeline?.removeTrack) {
      try {
        // Its children (Parent, R6) are detached in the same undo step and keep
        // their place on screen at the playhead.
        const keepOnScreenTick = Math.max(0, Math.round(beatsToTicks(playheadBeatRef.current || 0)))
        await window.xleth.timeline.removeTrack(id, { keepOnScreenTick })
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) => prev.filter((t) => t.id !== id))
  }, [fetchTracks, tracks])

  // ── Pattern-track conversion helpers ───────────────────────────────────────

  // Auto-generate the next unique pattern name (flat global numbering —
  // pattern tracks are sample-agnostic, so names are scoped to the project).
  // The regionId argument is retained for call-site symmetry but unused.
  const nextPatternName = useCallback((_regionId) => {
    const used = new Set(Object.values(patterns).map(p => p.name))
    let n = 1
    while (used.has(`Pattern ${n}`)) n++
    return `Pattern ${n}`
  }, [patterns])

  // Auto-generate a distinguishable name for a "Make Unique Copy" of an
  // existing pattern. A trailing " N" (e.g. "Pattern 2") increments N;
  // a trailing " #N" increments N; anything else gets " #2" appended.
  // Either way we walk forward past existing names to stay unique.
  const nextUniqueCopyName = useCallback((origName) => {
    const used = new Set(Object.values(patterns).map(p => p.name))
    const hashMatch = origName.match(/^(.*)\s#(\d+)$/)
    const trailingNumMatch = origName.match(/^(.*\D)(\d+)$/)
    if (hashMatch) {
      const base = hashMatch[1]
      let n = parseInt(hashMatch[2], 10) + 1
      while (used.has(`${base} #${n}`)) n++
      return `${base} #${n}`
    }
    if (trailingNumMatch) {
      const base = trailingNumMatch[1]
      let n = parseInt(trailingNumMatch[2], 10) + 1
      while (used.has(`${base}${n}`)) n++
      return `${base}${n}`
    }
    let n = 2
    while (used.has(`${origName} #${n}`)) n++
    return `${origName} #${n}`
  }, [patterns])

  // Core: convert a Clip track → Pattern track (sample-agnostic container).
  // Deletes existing clips, then flips the track type. Caller is responsible
  // for the confirmation UI when the track has clips.
  const performConvertToPatternTrack = useCallback(async (trackId) => {
    try {
      // Clearing the track and converting it is one edit: it used to be one
      // undo entry per clip plus one for the conversion, so Ctrl+Z gave back a
      // Pattern track's type but not its clips (or one clip at a time).
      await withUndoGroup('Convert to Pattern track', async () => {
        const existing = clipsRef.current.filter(c => c.trackId === trackId).map(c => c.id)
        if (existing.length > 0) await window.xleth?.timeline?.removeClipsBatch(existing)
        // Convert track (no region binding — pattern tracks are sample-agnostic)
        await window.xleth?.timeline?.convertToPatternTrack(trackId)
      })
      console.log(`[Timeline] Converted track ${trackId} → Pattern`)
      // Notify all listeners
      await fetchTracks()
      await fetchClips()
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      return true
    } catch (err) {
      console.error('[Timeline] convertToPatternTrack failed:', err)
      return false
    }
  }, [fetchTracks, fetchClips, withUndoGroup])

  const handleAddTrack = useCallback(async (trackType = 'Clip') => {
    const num = nextTrackNum.current++
    const name = `Track ${num}`
    console.log(`[Timeline] Track added: ${name}`)
    if (window.xleth?.timeline?.addTrack) {
      try {
        const newId = await window.xleth.timeline.addTrack({ name, order: tracks.length })
        if (trackType === 'Pattern' && newId != null && newId >= 0) {
          await performConvertToPatternTrack(newId)
        } else {
          await fetchTracks()
        }
        return
      } catch { /* fall through to local */ }
    }
    // Offline / no-engine fallback — add locally
    setTracks((prev) => [
      ...prev,
      { id: Date.now(), name, type: trackType === 'Pattern' ? 'Pattern' : 'Audio', volume: 1, pan: 0, muted: false, solo: false, visualOnly: false },
    ])
  }, [fetchTracks, tracks.length, performConvertToPatternTrack])

  // Wrap convert with a confirmation dialog when the track has clips
  const confirmAndConvertToPatternTrack = useCallback((track) => {
    return new Promise((resolve) => {
      const clipCount = clipsRef.current.filter(c => c.trackId === track.id).length
      if (clipCount === 0) {
        performConvertToPatternTrack(track.id).then((ok) => resolve(ok))
        return
      }
      setConfirmDialog({
        title: 'Convert to Pattern Track?',
        message: (
          <>
            Convert <strong>"{track.name}"</strong> to a Pattern Track?
            <br />
            This will delete <strong>{clipCount} clip{clipCount !== 1 ? 's' : ''}</strong> on this track.
          </>
        ),
        confirmLabel: 'Convert',
        onConfirm: async () => {
          setConfirmDialog(null)
          const ok = await performConvertToPatternTrack(track.id)
          resolve(ok)
        },
        onCancel: () => { setConfirmDialog(null); resolve(false) },
      })
    })
  }, [performConvertToPatternTrack])

  const handleConvertToClipTrack = useCallback(async (trackId) => {
    try {
      await window.xleth?.timeline?.convertToClipTrack(trackId)
      console.log(`[Timeline] Converted track ${trackId} → Clip`)
      setCurrentPatternIdByTrack(prev => {
        const next = { ...prev }
        delete next[trackId]
        return next
      })
      await fetchTracks()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    } catch (err) {
      console.error('[Timeline] convertToClipTrack failed:', err)
    }
  }, [setCurrentPatternIdByTrack, fetchTracks])

  const handleNewPatternForTrack = useCallback(async (trackId) => {
    const track = tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'Pattern') return
    // Seed the new pattern's regionId:
    // 1) the sample highlighted in the Sample Selector, or
    // 2) the track's currently-active pattern, or
    // 3) the first Pitch region.
    let seedRegionId = -1
    if (activeSampleId != null && regions[activeSampleId]) {
      seedRegionId = activeSampleId
    }
    if (seedRegionId < 0) {
      const currentPatId = currentPatternIdByTrack?.[trackId]
      if (currentPatId != null && currentPatId >= 0) {
        seedRegionId = patterns[currentPatId]?.regionId ?? -1
      }
    }
    if (seedRegionId < 0) {
      const firstPitch = Object.values(regions).find(r => r.label === 'Pitch')
      if (firstPitch) seedRegionId = firstPitch.id
    }
    if (seedRegionId < 0) {
      console.warn('[Timeline] No Pitch region available — cannot create new pattern')
      return
    }
    const name = nextPatternName(seedRegionId)
    try {
      const patternId = await window.xleth?.timeline?.addPattern({
        name,
        regionId: seedRegionId,
        lengthTicks: PPQ * 4,
      })
      if (patternId != null && patternId >= 0) {
        setCurrentPatternIdByTrack(prev => ({ ...prev, [trackId]: patternId }))
      }
      await fetchPatterns()
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
      console.log(`[Timeline] New pattern "${name}" (id=${patternId}) created for track ${trackId}`)
    } catch (err) {
      console.error('[Timeline] addPattern failed:', err)
    }
  }, [tracks, patterns, regions, currentPatternIdByTrack, nextPatternName, setCurrentPatternIdByTrack, fetchPatterns, activeSampleId])

  const handleSelectPatternForTrack = useCallback((trackId, patternId) => {
    setCurrentPatternIdByTrack(prev => ({ ...prev, [trackId]: patternId }))
    console.log(`[Timeline] Track ${trackId} current pattern → ${patternId}`)
  }, [setCurrentPatternIdByTrack])

  // Flip-config editing moved to the Video tab's Track Detail view
  // (TrackVideoProperties → TrackFlipSection), which commits directly via the
  // setVideoFlipConfig IPC. The context menu now just navigates there.

  const handleSetVideoHoldLastFrame = useCallback(async (trackId, hold) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(trackId, hold)
      await fetchTracks()
      console.log(`[Timeline] Track ${trackId} videoHoldLastFrame → ${hold}`)
    } catch (err) {
      console.error('[Timeline] setVideoHoldLastFrame failed:', err)
    }
  }, [fetchTracks])

  const handleRequestTrackContextMenu = useCallback((track, x, y) => {
    setTrackMenu({ track, x, y })
  }, [])

  // Track menu → select this track (clearing clip/block selection so the
  // Inspector shows the track) and reveal the Inspector.
  const selectTrackInInspector = useCallback((trackId) => {
    setSelectedTrackIds(new Set([trackId]))
    setSelectedClipIds(new Set())
    setSelectedBlockIds(new Set())
    revealInspector()
  }, [])

  // Clones (docs/XLETH_CLONE_SPEC.md): one engine command each (one undo step).
  // cloneApi dispatches the change events; the refetch keeps this view in step
  // even when the event lands before the engine's next getTracks.
  const handleAddClone = useCallback(async (sourceTrackId, kind) => {
    const res = await addClone(sourceTrackId, kind)
    if (res) await fetchTracks()
  }, [fetchTracks])

  const handleMoveClone = useCallback(async (cloneId, delta) => {
    const res = await moveClone(tracks, cloneId, delta)
    if (res) await fetchTracks()
  }, [tracks, fetchTracks])

  const buildTrackMenuItems = useCallback((track) => {
    if (!track) return []
    const items = []

    // A Clone owns no pattern blocks (the engine refuses them), so it has no
    // pattern, conversion or hold items: only its order among its source's
    // Clones, the Inspector and delete.
    if (isClone(track)) {
      return cloneMenuItems(track, tracks, {
        moveClone: (delta) => handleMoveClone(track.id, delta),
        showInInspector: () => selectTrackInInspector(track.id),
        remove: () => handleRemove(track.id),
      })
    }

    if (track.type === 'Pattern') {
      const allPatterns = Object.values(patterns).sort((a, b) => a.id - b.id)
      const currentPatId = currentPatternIdByTrack?.[track.id]
      items.push({
        label: 'New Pattern',
        onClick: () => handleNewPatternForTrack(track.id),
      })
      items.push({
        label: 'Select Pattern',
        disabled: allPatterns.length === 0,
        submenu: allPatterns.map(p => ({
          label: p.name || `Pattern ${p.id}`,
          checked: p.id === currentPatId,
          onClick: () => handleSelectPatternForTrack(track.id, p.id),
        })),
      })
      items.push({ type: 'separator' })
      // Extra video cells driven by this track: a Voice clone shows the notes it
      // cannot (polyphony), a Trail clone replays it later.
      items.push(...(cloneMenuItems(track, tracks, {
        addClone: (kind) => handleAddClone(track.id, kind),
      }) ?? []))
      items.push({ type: 'separator' })
      items.push({
        label: 'Convert to Clip Track',
        onClick: () => handleConvertToClipTrack(track.id),
      })
    } else {
      // Clip track → convert to sample-agnostic Pattern track
      items.push({
        label: 'Convert to Pattern Track',
        onClick: () => confirmAndConvertToPatternTrack(track),
      })
    }

    // Track properties (flip, hold, corner radius, gap, visual FX, ...) live in
    // the Inspector. Mark "✓" while the flip cycle is on so the menu still
    // surfaces that state at a glance.
    items.push({
      label: 'Show in Inspector',
      checked: !!track.videoFlipConfig?.enabled,
      onClick: () => selectTrackInInspector(track.id),
    })

    const currentHold = track.videoHoldLastFrame || false
    items.push({
      label: 'Hold Last Frame',
      checked: currentHold,
      onClick: () => handleSetVideoHoldLastFrame(track.id, !currentHold),
    })

    // Placement-mode actions (Assign to Grid / Make Fullscreen / Convert /
    // Unplace) are deliberately NOT shown here. They live in the Preview's
    // Edit Grid layer list (VideoTrackList.jsx), where the grid and fullscreen
    // state is actually visualized.

    items.push({ type: 'separator' })
    items.push({
      label: 'Delete Track',
      danger: true,
      onClick: () => handleRemove(track.id),
    })
    return items
  }, [tracks, patterns, currentPatternIdByTrack, handleNewPatternForTrack, handleSelectPatternForTrack, handleSetVideoHoldLastFrame, handleConvertToClipTrack, confirmAndConvertToPatternTrack, handleRemove, selectTrackInInspector, handleAddClone, handleMoveClone])

  // ── Seek via ruler ─────────────────────────────────────────────────────────

  const handleSeek = useCallback((beat, options = {}) => {
    const phase = options.phase || 'commit'
    const shouldCommitTransport = phase === 'commit'
    const clampedBeat = Math.max(0, beat)

    editCursor.setPosition(clampedBeat)
    const posMs = clampedBeat * 60000 / bpmRef.current
    playheadClock.seekLocally(posMs, bpmRef.current, isPlayingRef.current, clampedBeat)
    playheadBeatRef.current = clampedBeat
    canvasRef.current?.positionPlayhead(clampedBeat)
    rulerRef.current?.redrawOverlay()

    if (!isPlayingRef.current) {
      const scheduler = stoppedPreviewSeekSchedulerRef.current
      scheduler?.schedule({ beat: clampedBeat })
      if (shouldCommitTransport) scheduler?.flush()
    }

    if (shouldCommitTransport) {
      window.xleth?.transport?.seek(clampedBeat)  // final real transport/edit position
    }
  }, [])

  // ── Mutation callbacks (passed to tools via canvas) ────────────────────────

  const handleCreateClip = useCallback(async (trackId, regionId, positionTicks, durationTicks, opts = {}) => {
    const { regionOffsetTicks = 0, velocity = 1.0, pitchOffset = 0, syllableIndex = -1 } = opts
    console.log(`[PencilTool] Creating clip: region=${regionId}, track=${trackId}, pos=${positionTicks}t, dur=${durationTicks}t`)
    try {
      const [clipId] = await addClipsAndSplice([{
        trackId, regionId, positionTicks, durationTicks,
        regionOffsetTicks, velocity, pitchOffset, syllableIndex,
      }])
      console.log(`[PencilTool] Clip created: id=${clipId}`)
    } catch (err) {
      console.error('[PencilTool] addClip failed:', err)
      // The engine may or may not have taken the clip: resync rather than guess.
      await fetchClips()
    }
  }, [addClipsAndSplice, fetchClips])

  const handleDeleteClip = useCallback(async (clipId) => {
    console.log(`[DeleteTool] Deleting clip ${clipId}`)
    try {
      await window.xleth?.timeline?.removeClip(clipId)
      setSelectedClipIds((prev) => {
        const next = new Set(prev)
        next.delete(clipId)
        return next
      })
      applyClipDelta({ removed: [clipId] })
    } catch (err) {
      console.error(`[DeleteTool] removeClip(${clipId}) failed:`, err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  // moves: [{ clipId, trackId, positionTicks }, ...]
  //
  // At most two engine round trips for the whole selection — one batched remove
  // for whatever the move buries, one batched move — instead of N of each. The
  // canvas is repainted from local state immediately and reconciled against
  // the engine afterwards, so a large drag lands instantly instead of waiting
  // on the round trips to come back.
  const handleMoveClips = useCallback(async (moves) => {
    if (!Array.isArray(moves) || moves.length === 0) return
    await runSerializedEdit(async () => {
      const byId = new Map(moves.map(m => [m.clipId, m]))
      // A move overwrites what it lands on, exactly like a paste. The moved
      // clips carry their own durations over from the pre-move snapshot —
      // `moves` only names a destination. One pass to index those durations: a
      // find() per move walked the whole clip list once per moved clip.
      const durationById = new Map()
      for (const c of clipsRef.current) if (byId.has(c.id)) durationById.set(c.id, c.durationTicks)
      const { doomedClipIds } = resolveOverwritePlan({
        existingClips: clipsRef.current,
        clipPlacements: moves.map(m => ({
          trackId: m.trackId,
          positionTicks: m.positionTicks,
          durationTicks: durationById.get(m.clipId) ?? 0,
        })),
        movingClipIds: new Set(byId.keys()),
      })
      const doomed = new Set(doomedClipIds)
      const optimistic = clipsRef.current
        .filter(c => !doomed.has(c.id))
        .map(c => {
          const m = byId.get(c.id)
          return m ? { ...c, trackId: m.trackId, positionTicks: m.positionTicks } : c
        })
      setClips(optimistic)
      clipsRef.current = optimistic
      try {
        // Remove first: the engine does not police occupancy, so moving onto a
        // still-occupied slot is what produced the silent stack.
        if (doomedClipIds.length > 0) {
          const removedIds = await window.xleth?.timeline?.removeClipsBatch(doomedClipIds)
          applyClipDelta({ removed: removedIds ?? doomedClipIds })
        }
        // Both calls answer with post-state, so a 200-clip drag costs exactly
        // two round trips and NO getClips — it used to end in a refetch of every
        // clip in the project just to learn the positions it already knew.
        const movedClips = await window.xleth?.timeline?.moveClipsBatch(moves)
        applyClipDelta({ updated: movedClips ?? [] })
      } catch (err) {
        console.error(`[SelectTool] moveClipsBatch(${moves.length}) failed:`, err)
        // The optimistic repaint above is now a guess: resync against the engine.
        await fetchClips()
      }
      if (doomedClipIds.length > 0) {
        console.log(`[SelectTool] Move overwrote ${doomedClipIds.length} clip(s)`)
      }
    })
  }, [fetchClips, applyClipDelta, runSerializedEdit])

  // Shift+drag duplicate. One atomic overwrite+insert, one undo entry — this
  // used to be an awaited addClip per placement, and it stacked on whatever it
  // landed on. (Alt is the free/no-snap modifier, not the duplicate one; see
  // selectTool.js.)
  const handleDuplicateClips = useCallback(async (placements) => {
    if (!Array.isArray(placements) || placements.length === 0) return
    await runSerializedEdit(async () => {
      try {
        // The sources stay put, so nothing is excluded — a duplicate dropped
        // back onto its own source legitimately buries it.
        const { doomedClipIds } = resolveOverwritePlan({
          existingClips: clipsRef.current,
          clipPlacements: placements.map(({ clip, trackId, positionTicks }) => ({
            trackId, positionTicks, durationTicks: clip.durationTicks,
          })),
        })
        const payloads = placements.map(({ clip, trackId, positionTicks }) =>
          clipPayloadFromSnapshot(clip, trackId, positionTicks))
        // pasteClipsBatch, not addClipsBatch: remove + insert land as ONE undo
        // entry, so Ctrl+Z cannot peel off the insert and leave the buried
        // clips deleted.
        const res = await window.xleth?.timeline?.pasteClipsBatch({
          removeClipIds: doomedClipIds,
          clips: payloads,
        })
        applyClipDelta({ updated: res?.clips ?? [], removed: res?.removedIds ?? [] })
        setSelectedClipIds(new Set(res?.newIds ?? []))
        if (doomedClipIds.length > 0) {
          console.log(`[SelectTool] Duplicate overwrote ${doomedClipIds.length} clip(s)`)
        }
      } catch (err) {
        console.error('[SelectTool] Duplicate drag failed:', err)
        await fetchClips()
      }
    })
  }, [fetchClips, applyClipDelta, runSerializedEdit])

  // newRegionOffset is only passed for a reversed clip, whose right edge sits
  // on the START of its source window (timeline/clipTrim.js).
  const handleResizeClip = useCallback(async (clipId, newDurationTicks, newRegionOffset) => {
    console.log(`[SelectTool] Resizing clip ${clipId}: dur=${newDurationTicks}t`
      + (newRegionOffset != null ? `, offset=${newRegionOffset}t` : ''))
    try {
      const updated = newRegionOffset != null
        ? await window.xleth?.timeline?.resizeClip(clipId, newDurationTicks, newRegionOffset)
        : await window.xleth?.timeline?.resizeClip(clipId, newDurationTicks)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error(`[SelectTool] resizeClip(${clipId}) failed:`, err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  // Splitting is the engine's job (model/ClipSplit.h). It knows which piece
  // keeps which part of the source, including on stretched and reversed clips,
  // and what happens to the fades; this used to rebuild both halves here from a
  // snapshot, a second copy of that arithmetic that handed a reversed clip's
  // halves each other's audio and put both fades on both pieces. One call, one
  // undo entry, and the reply carries the two new clips.
  const splitClipsAt = useCallback(async (entries) => {
    const res = await window.xleth?.timeline?.spliceClipsAtPlayhead(entries)
    const pairs = Array.isArray(res) ? res : (res?.pairs ?? [])
    if (Array.isArray(res?.clips)) {
      applyClipDelta({ updated: res.clips, removed: res.removedIds ?? [] })
    } else {
      // An engine that still answers with bare id pairs: resync the old way.
      await fetchClips()
    }
    return pairs
  }, [applyClipDelta, fetchClips])

  const handleSplitClip = useCallback(async (clipId, leftDuration) => {
    const clip = clipsRef.current.find((c) => c.id === clipId)
    if (!clip) return
    const splitTick = clip.positionTicks + leftDuration
    console.log(`[SplitTool] Splitting clip ${clipId} at ${splitTick}t`)
    try {
      await splitClipsAt([{ clipId, splitTick }])
      setSelectedClipIds(new Set())
      console.log(`[SplitTool] Split complete`)
    } catch (err) {
      console.error(`[SplitTool] split failed:`, err)
      await fetchClips()
    }
  }, [fetchClips, splitClipsAt])

  // Splits every selected clip that the transport playhead currently intersects.
  // Returns true if at least one clip was split (used to decide S key fallback).
  const handleSpliceSelectedClips = useCallback(async (splitTick) => {
    const qualifying = clipsRef.current.filter(
      (c) => selectedClipIds.has(c.id) &&
             splitTick > c.positionTicks &&
             splitTick < c.positionTicks + c.durationTicks
    )
    if (qualifying.length === 0) return false
    const entries = qualifying.map((c) => ({ clipId: c.id, splitTick }))
    try {
      const pairs = await splitClipsAt(entries)
      setSelectedClipIds(new Set(pairs.flat()))
    } catch (err) {
      console.error('[Splice] spliceClipsAtPlayhead failed:', err)
    }
    return true
  }, [selectedClipIds, splitClipsAt])

  // ── Pattern Block mutations (used by tools) ────────────────────────────────

  const handleCreatePatternBlock = useCallback(async (trackId, patternId, positionTicks, durationTicks, offsetTicks = 0) => {
    console.log(`[PencilTool] Creating pattern block: track=${trackId}, pattern=${patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
    try {
      const blockId = await window.xleth?.timeline?.addPatternBlock({
        trackId, patternId, positionTicks, durationTicks, offsetTicks,
      })
      console.log(`[PencilTool] Pattern block created: id=${blockId}`)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[PencilTool] addPatternBlock failed:', err)
    }
  }, [])

  // moves: [{ blockId, trackId, positionTicks }, ...]
  //
  // There is no movePatternBlocks RPC — blocks are cheap metadata with no
  // render cache behind them — so this pipelines the per-block calls instead
  // of awaiting them one after another, and fires a single change event.
  const handleMovePatternBlocks = useCallback(async (moves) => {
    if (!Array.isArray(moves) || moves.length === 0) return
    await runSerializedEdit(async () => {
      const byId = new Map(moves.map(m => [m.blockId, m]))
      // Same overwrite policy as clips — a block move used to stack silently.
      const { doomedBlockIds } = resolveOverwritePlan({
        existingBlocks: patternBlocksRef.current,
        blockPlacements: moves.map(m => ({
          trackId: m.trackId,
          positionTicks: m.positionTicks,
          durationTicks: patternBlocksRef.current.find(b => b.id === m.blockId)?.durationTicks ?? 0,
        })),
        movingBlockIds: new Set(byId.keys()),
      })
      const doomed = new Set(doomedBlockIds)
      setPatternBlocks(prev => prev.filter(b => !doomed.has(b.id)).map(b => {
        const m = byId.get(b.id)
        return m ? { ...b, trackId: m.trackId, positionTicks: m.positionTicks } : b
      }))
      try {
        await Promise.all(doomedBlockIds.map(id =>
          window.xleth?.timeline?.removePatternBlock(id)
        ))
        await Promise.all(moves.map(m =>
          window.xleth?.timeline?.movePatternBlock(m.blockId, m.trackId, m.positionTicks)
        ))
      } catch (err) {
        console.error('[SelectTool] movePatternBlocks failed:', err)
      }
      // There is still no movePatternBlocksBatch RPC — only the ADD side was
      // batched (addPatternBlocksBatch / pastePatternBlocksBatch) — so every
      // remove and every move here is its own engine command. They are one
      // undo entry all the same: runSerializedEdit groups the gesture.
      await fetchPatternBlocks()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      if (doomedBlockIds.length > 0) {
        console.log(`[SelectTool] Move overwrote ${doomedBlockIds.length} pattern block(s)`)
      }
    })
  }, [fetchPatternBlocks, runSerializedEdit])

  const handleDuplicatePatternBlocks = useCallback(async (placements) => {
    if (!Array.isArray(placements) || placements.length === 0) return
    await runSerializedEdit(async () => {
      try {
        // The sources stay put, so nothing is excluded.
        const { doomedBlockIds } = resolveOverwritePlan({
          existingBlocks: patternBlocksRef.current,
          blockPlacements: placements.map(({ block, trackId, positionTicks }) => ({
            trackId, positionTicks, durationTicks: block.durationTicks,
          })),
        })
        // One atomic overwrite+insert: ONE round trip and ONE undo entry, where
        // this used to be N pipelined adds plus a setPatternBlockLoop per looped
        // block, each its own engine entry. loopEnabled now rides on the block.
        const res = await window.xleth?.timeline?.pastePatternBlocksBatch({
          removeBlockIds: doomedBlockIds,
          blocks: placements.map(({ block, trackId, positionTicks }) => ({
            trackId,
            patternId: block.patternId,
            positionTicks,
            durationTicks: block.durationTicks,
            offsetTicks: block.offsetTicks ?? 0,
            loopEnabled: block.loopEnabled ?? false,
          })),
        })
        const newIds = (res?.blocks ?? []).map(b => b.id)
        applyPatternBlockDelta({ updated: res?.blocks ?? [], removed: res?.removedIds ?? [] })
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
        setSelectedBlockIds(new Set(newIds))
        if (doomedBlockIds.length > 0) {
          console.log(`[SelectTool] Duplicate overwrote ${doomedBlockIds.length} pattern block(s)`)
        }
      } catch (err) {
        console.error('[SelectTool] Pattern duplicate drag failed:', err)
        await fetchPatternBlocks()
      }
    })
  }, [fetchPatternBlocks, applyPatternBlockDelta, runSerializedEdit])

  const handleResizePatternBlock = useCallback(async (blockId, durationTicks) => {
    console.log(`[SelectTool] Resizing pattern block ${blockId}: dur=${durationTicks}t`)
    try {
      await window.xleth?.timeline?.resizePatternBlock(blockId, durationTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] resizePatternBlock failed:', err)
    }
  }, [])

  const handleResizePatternBlockLeft = useCallback(async (blockId, positionTicks, durationTicks, offsetTicks) => {
    console.log(`[SelectTool] Left-resizing pattern block ${blockId}: pos=${positionTicks}t, dur=${durationTicks}t, offset=${offsetTicks}t`)
    try {
      await window.xleth?.timeline?.resizePatternBlockLeft(blockId, positionTicks, durationTicks, offsetTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] resizePatternBlockLeft failed:', err)
    }
  }, [])

  const handleDeletePatternBlock = useCallback(async (blockId) => {
    console.log(`[DeleteTool] Deleting pattern block ${blockId}`)
    try {
      await window.xleth?.timeline?.removePatternBlock(blockId)
      setSelectedBlockIds(prev => {
        const next = new Set(prev)
        next.delete(blockId)
        return next
      })
      // Optimistic: remove from local state immediately so the canvas doesn't
      // repaint the ghost block during the async reconciliation fetch.
      setPatternBlocks(prev => prev.filter(b => b.id !== blockId))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[DeleteTool] removePatternBlock failed:', err)
    }
  }, [])

  const handleMakeUniquePatternBlock = useCallback(async (blockId) => {
    const block = patternBlocks.find(b => b.id === blockId)
    if (!block) return
    const orig = patterns[block.patternId]
    if (!orig) return
    try {
      const newPatternId = await window.xleth?.timeline?.addPattern({
        name: nextUniqueCopyName(orig.name),
        regionId: orig.regionId,
        lengthTicks: orig.lengthTicks,
      })
      if (newPatternId == null || newPatternId < 0) return
      if (orig.notes?.length > 0) {
        // addNotesBatch assigns fresh ids in list order, so each note's Lens
        // override lands on its own copy's new id.
        await window.xleth?.timeline?.addNotesBatch(
          newPatternId,
          orig.notes.map(toNewNoteCopy)
        )
      }
      await window.xleth?.timeline?.removePatternBlock(blockId)
      const newBlockId = await window.xleth?.timeline?.addPatternBlock({
        trackId: block.trackId,
        patternId: newPatternId,
        positionTicks: block.positionTicks,
        durationTicks: block.durationTicks,
        offsetTicks: block.offsetTicks ?? 0,
      })
      if (block.loopEnabled && newBlockId != null && newBlockId >= 0) {
        await window.xleth?.timeline?.setPatternBlockLoop(newBlockId, true)
      }
      await fetchPatterns()
      await fetchPatternBlocks()
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      if (newBlockId != null && newBlockId >= 0) {
        setSelectedBlockIds(new Set([newBlockId]))
        setCurrentPatternIdByTrack(prev => ({ ...prev, [block.trackId]: newPatternId }))
      }
      console.log(`[SelectTool] Made unique copy: block ${blockId} → new pattern ${newPatternId}, new block ${newBlockId}`)
    } catch (err) {
      console.error('[SelectTool] makeUniquePatternBlock failed:', err)
    }
  }, [patternBlocks, patterns, fetchPatterns, fetchPatternBlocks, setCurrentPatternIdByTrack, nextUniqueCopyName])

  // ── Automation clips (Phase B) — move/resize mirror the pattern-block
  // handlers above; make-unique is a single engine command (NOT the
  // UI-composed RPC chain handleMakeUniquePatternBlock uses), per the locked
  // spec — automation's independent-copy semantics live entirely engine-side.
  const handleMoveAutomationClip = useCallback(async (moves) => {
    if (!Array.isArray(moves) || moves.length === 0) return
    const byId = new Map(moves.map(m => [m.clipId, m]))
    setAutomationClips(prev => prev.map(c => {
      const m = byId.get(c.id)
      return m ? { ...c, laneId: m.laneId, positionTicks: m.positionTicks } : c
    }))
    try {
      await Promise.all(moves.map(m =>
        window.xleth?.automation?.moveClip(m.clipId, m.laneId, m.positionTicks)
      ))
    } catch (err) {
      console.error('[SelectTool] moveAutomationClip failed:', err)
    }
    await fetchAutomationClips()
    timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
  }, [fetchAutomationClips])

  const handleResizeAutomationClip = useCallback(async (clipId, durationTicks) => {
    try {
      await window.xleth?.automation?.resizeClip(clipId, durationTicks)
      await fetchAutomationClips()
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
    } catch (err) {
      console.error('[SelectTool] resizeAutomationClip failed:', err)
    }
  }, [fetchAutomationClips])

  const handleResizeAutomationClipLeft = useCallback(async (clipId, positionTicks, durationTicks, offsetTicks) => {
    try {
      await window.xleth?.automation?.resizeClipLeft(clipId, positionTicks, durationTicks, offsetTicks)
      await fetchAutomationClips()
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
    } catch (err) {
      console.error('[SelectTool] resizeAutomationClipLeft failed:', err)
    }
  }, [fetchAutomationClips])

  // NOTE: automation_makeClipUnique does NOT create a new clip — the clip id
  // stays the same. It duplicates the ENVELOPE the clip references and
  // repoints the clip at the copy (returning the new envelopeId), so this
  // clip's points diverge from any other clip still sharing the original
  // envelope. Selection is unaffected; only the envelope binding changed.
  const handleMakeUniqueAutomationClip = useCallback(async (clipId) => {
    try {
      const newEnvelopeId = await window.xleth?.automation?.makeClipUnique(clipId)
      await fetchAutomationClips()
      await fetchAutomationEnvelopes()
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
      console.log(`[SelectTool] Made unique copy: automation clip ${clipId} → envelope ${newEnvelopeId}`)
    } catch (err) {
      console.error('[SelectTool] makeClipUnique failed:', err)
    }
  }, [fetchAutomationClips, fetchAutomationEnvelopes])

  // Shift+drag duplicate — mirrors handleDuplicatePatternBlocks, but a
  // duplicated automation clip SHARES its source's envelopeId (FL semantics:
  // copies share until make-unique), so this never calls addEnvelope. The
  // engine rejects same-lane overlap outright (returns clipId -1) rather than
  // shifting the request, so each placement has to be resolved against both the
  // existing lane contents and any earlier clip this same drag placed on the
  // same lane — the dependency that used to make this a serial await-per-clip
  // with a running occupancy map here. addClipsBatch owns it now: one round
  // trip, and ONE undo entry where a 5-clip drag-duplicate used to push five
  // and Ctrl+Z removed exactly one of them.
  const handleDuplicateAutomationClips = useCallback(async (placements) => {
    if (!Array.isArray(placements) || placements.length === 0) return
    try {
      const landed = await window.xleth?.automation?.addClipsBatch(
        placements.map(({ clip, positionTicks, laneId }) => ({
          laneId,
          envelopeId: clip.envelopeId,
          positionTicks,
          durationTicks: clip.durationTicks,
          offsetTicks: clip.offsetTicks ?? 0,
        })))
      const newIds = (landed ?? []).map(c => c.id)
      await fetchAutomationClips()
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
      if (newIds.length > 0) setSelectedAutomationClipIds(new Set(newIds))
      console.log(`[SelectTool] Duplicated ${newIds.length} automation clip(s) by drag`)
    } catch (err) {
      console.error('[SelectTool] Automation duplicate drag failed:', err)
    }
  }, [fetchAutomationClips])

  // "Loop to Edit Cursor": repeats the selected automation clips (or just the
  // right-clicked one) as a group until the edit cursor, as ONE undo step.
  // Copies share the source envelope, exactly like a drag-duplicate.
  const handleLoopAutomationClips = useCallback(async (clickedClipId) => {
    const all = automationClipsRef.current ?? []
    const sel = selectedAutomationClipIdsRef.current
    const ids = sel?.has(clickedClipId) ? sel : new Set([clickedClipId])
    const sources = all.filter(c => ids.has(c.id))
    const endTick = beatsToTicks(Math.max(0, editCursor.getPosition()))
    const plan = planAutomationLoop(sources, endTick, all)
    if (plan.length === 0) {
      console.log('[Loop] Nothing to loop — move the edit cursor to the right of the selected automation clip(s)')
      return
    }
    await handleDuplicateAutomationClips(plan)
    console.log(`[Loop] Looped ${sources.length} automation clip(s) to tick ${endTick} (${plan.length} copies)`)
  }, [handleDuplicateAutomationClips])

  const handleDeleteAutomationClip = useCallback(async (clipId) => {
    try {
      await window.xleth?.automation?.removeClip(clipId)
      setSelectedAutomationClipIds(prev => {
        const next = new Set(prev)
        next.delete(clipId)
        return next
      })
      setAutomationClips(prev => prev.filter(c => c.id !== clipId))
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
    } catch (err) {
      console.error('[DeleteTool] removeAutomationClip failed:', err)
    }
  }, [])

  // ── Automation POINT editing (Phase C) ────────────────────────────────────
  // Each of these is ONE engine command = ONE undo step. The drag path only
  // ever calls onMoveAutomationPoint, once, from the select tool's mouseup —
  // never during the drag itself.
  //
  // Every call is verified present before use: the four-layer bridge
  // optional-chains missing methods away, so a typo here would silently do
  // nothing instead of failing.
  const refreshAutomationAfterPointEdit = useCallback(async () => {
    await fetchAutomationEnvelopes()
    canvasRef.current?.redrawContent('automation-points')
    timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
  }, [fetchAutomationEnvelopes])

  const handleAddAutomationPoint = useCallback(async (envelopeId, tick, value) => {
    const fn = window.xleth?.automation?.addPoint
    if (typeof fn !== 'function') {
      console.warn('[Timeline] automation.addPoint is unavailable — point not added')
      return
    }
    try {
      const ok = await fn(envelopeId, { tick, value, curveType: 0, tension: 0 })
      if (ok === false) console.warn(`[Timeline] automation.addPoint rejected (envelope ${envelopeId}, tick ${tick})`)
      await refreshAutomationAfterPointEdit()
    } catch (err) {
      console.error('[Timeline] addAutomationPoint failed:', err)
    }
  }, [refreshAutomationAfterPointEdit])

  const handleRemoveAutomationPoint = useCallback(async (envelopeId, pointIndex) => {
    const fn = window.xleth?.automation?.removePoint
    if (typeof fn !== 'function') {
      console.warn('[Timeline] automation.removePoint is unavailable — point not removed')
      return
    }
    try {
      const ok = await fn(envelopeId, pointIndex)
      if (ok === false) console.warn(`[Timeline] automation.removePoint rejected (envelope ${envelopeId}, index ${pointIndex})`)
      setSelectedAutomationPoint(null)
      await refreshAutomationAfterPointEdit()
    } catch (err) {
      console.error('[Timeline] removeAutomationPoint failed:', err)
    }
  }, [refreshAutomationAfterPointEdit])

  const handleMoveAutomationPoint = useCallback(async (envelopeId, pointIndex, tick, value) => {
    const fn = window.xleth?.automation?.movePoint
    if (typeof fn !== 'function') {
      console.warn('[Timeline] automation.movePoint is unavailable — point move dropped')
      return
    }
    try {
      const ok = await fn(envelopeId, pointIndex, tick, value)
      if (ok === false) console.warn(`[Timeline] automation.movePoint rejected (envelope ${envelopeId}, index ${pointIndex})`)
      await refreshAutomationAfterPointEdit()
    } catch (err) {
      console.error('[Timeline] moveAutomationPoint failed:', err)
    }
  }, [refreshAutomationAfterPointEdit])

  // Deletes a whole automation lane (and its clips) — one undoable engine
  // command. The parameter's envelope and base value survive, so re-automating
  // the knob later starts from where it was.
  const handleDeleteAutomationLane = useCallback(async (laneId) => {
    const fn = window.xleth?.automation?.removeLane
    if (typeof fn !== 'function') {
      console.warn('[Timeline] automation.removeLane is unavailable — lane not deleted')
      return
    }
    try {
      const doomed = new Set(automationClips.filter(c => c.laneId === laneId).map(c => c.id))
      const ok = await fn(laneId)
      if (ok === false) console.warn(`[Timeline] automation.removeLane rejected (lane ${laneId})`)
      setSelectedAutomationClipIds(prev => {
        if (![...prev].some(id => doomed.has(id))) return prev
        return new Set([...prev].filter(id => !doomed.has(id)))
      })
      setSelectedAutomationPoint(null)
      await fetchAutomationAll()
      canvasRef.current?.redrawContent('automation-points')
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
    } catch (err) {
      console.error('[Timeline] removeAutomationLane failed:', err)
    }
  }, [automationClips, fetchAutomationAll])

  const handleToggleReelLane = useCallback((trackId) => {
    useReelLaneStore.getState().toggle(trackId)
  }, [])

  const handleToggleAutomationGroup = useCallback((ownerTrackId, collapsed) => {
    setCollapsedAutomationGroups(prev => {
      const next = new Set(prev)
      if (collapsed) next.add(ownerTrackId); else next.delete(ownerTrackId)
      return next
    })
  }, [])

  const deleteSelectedTimelineItems = useCallback(async () => {
    // A selected envelope point is the finest-grained selection on the canvas,
    // so Delete removes it rather than the clip that contains it.
    if (selectedAutomationPoint) {
      await handleRemoveAutomationPoint(selectedAutomationPoint.envelopeId, selectedAutomationPoint.pointIndex)
      return true
    }
    if (selectedClipIds.size === 0 && selectedBlockIds.size === 0 && selectedAutomationClipIds.size === 0) return false

    const clipIdList = [...selectedClipIds]
    const blockIdList = [...selectedBlockIds]
    const automationClipIdList = [...selectedAutomationClipIds]
    const xl = window.xleth
    console.log(`[Keyboard] Deleting ${clipIdList.length} clip(s), ${blockIdList.length} block(s), ${automationClipIdList.length} automation clip(s)`)
    setSelectedClipIds(new Set())
    setSelectedBlockIds(new Set())
    setSelectedAutomationClipIds(new Set())
    // Repaint from local state first — the engine round trip below no longer
    // gates the canvas, so deleting a big selection feels instant.
    if (clipIdList.length > 0) {
      const doomed = new Set(clipIdList)
      const remaining = clipsRef.current.filter(c => !doomed.has(c.id))
      setClips(remaining)
      clipsRef.current = remaining
    }
    if (blockIdList.length > 0) {
      const doomed = new Set(blockIdList)
      setPatternBlocks(prev => prev.filter(b => !doomed.has(b.id)))
    }
    if (automationClipIdList.length > 0) {
      const doomed = new Set(automationClipIdList)
      setAutomationClips(prev => prev.filter(c => !doomed.has(c.id)))
    }
    // One undo entry for the whole selection. Clips go through one batch call;
    // pattern blocks and automation clips are still one call each, so the
    // gesture is grouped — Ctrl+Z used to put back exactly one item, and a
    // selection larger than the history could not be restored at all.
    await withUndoGroup('Delete selection', () => Promise.all([
      clipIdList.length > 0
        ? xl.timeline.removeClipsBatch(clipIdList).catch(err =>
            console.error(`[Keyboard] removeClipsBatch(${clipIdList.length}) failed:`, err))
        : null,
      ...blockIdList.map(id =>
        xl.timeline.removePatternBlock(id).catch(err =>
          console.error(`[Keyboard] removePatternBlock(${id}) failed:`, err)
        )
      ),
      ...automationClipIdList.map(id =>
        xl.automation?.removeClip(id).catch(err =>
          console.error(`[Keyboard] automation.removeClip(${id}) failed:`, err)
        )
      ),
    ]))
    // No refetch: the optimistic removal above already dropped exactly these
    // clips, and reconcileClipFxEditors still has to run for any floating clip-FX
    // editor bound to one of them.
    if (clipIdList.length > 0) applyClipDelta({ removed: clipIdList })
    if (blockIdList.length > 0) {
      await fetchPatternBlocks()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    }
    if (automationClipIdList.length > 0) {
      await fetchAutomationClips()
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
    }
    return true
  }, [applyClipDelta, fetchPatternBlocks, fetchAutomationClips, selectedBlockIds, selectedClipIds,
      selectedAutomationClipIds, selectedAutomationPoint, handleRemoveAutomationPoint, withUndoGroup])

  // Edit > Delete. In Motion view the Edit selection (clips, blocks, automation)
  // is hidden, so the command goes to Motion view's key delete (R20) and never
  // touches it; false = nothing to delete there.
  useEffect(() => (
    registerEditorCommand('timeline', 'deleteSelected', () => {
      if (timelineViewNameRef.current === 'motion') {
        return motionViewRef.current?.handleKeyCommand({ id: 'delete' }) === true
      }
      return deleteSelectedTimelineItems()
    })
  ), [deleteSelectedTimelineItems])

  const handleSplitPatternBlock = useCallback(async (blockId, splitPositionTicks) => {
    const block = patternBlocks.find(b => b.id === blockId)
    if (!block) return
    const pattern = patterns[block.patternId]
    const patLen = pattern?.lengthTicks || (PPQ * 4)
    const leftDur = splitPositionTicks - block.positionTicks
    const rightDur = block.durationTicks - leftDur
    if (leftDur <= 0 || rightDur <= 0) return
    const baseOffset = block.offsetTicks || 0
    const splitOffsetInPattern = (baseOffset + leftDur) % patLen
    console.log(`[SplitTool] Splitting block ${blockId}: leftDur=${leftDur}, rightDur=${rightDur}, secondOffset=${splitOffsetInPattern}`)
    try {
      // Two engine commands, one edit: undoing a split used to take two
      // presses, and the first left a shortened block with nothing after it.
      await withUndoGroup('Split pattern block', async () => {
        // Resize first half
        await window.xleth?.timeline?.resizePatternBlock(blockId, leftDur)
        // Create second half
        await window.xleth?.timeline?.addPatternBlock({
          trackId: block.trackId,
          patternId: block.patternId,
          positionTicks: splitPositionTicks,
          durationTicks: rightDur,
          offsetTicks: splitOffsetInPattern,
        })
      })
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SplitTool] splitPatternBlock failed:', err)
    }
  }, [patternBlocks, patterns, withUndoGroup])

  const handleResizeClipLeft = useCallback(async (clipId, newPositionTicks, newDurationTicks, newRegionOffset) => {
    console.log(`[SelectTool] Left-resize clip ${clipId}: pos=${newPositionTicks}t, dur=${newDurationTicks}t, offset=${newRegionOffset}t`)
    try {
      const updated = await window.xleth?.timeline?.resizeClipLeft(clipId, newPositionTicks, newDurationTicks, newRegionOffset)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error(`[SelectTool] resizeClipLeft(${clipId}) failed:`, err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleStretchClip = useCallback(async (clipId, newDurationTicks) => {
    console.log(`[SelectTool] Stretching clip ${clipId}: dur=${newDurationTicks}t`)
    try {
      const updated = await window.xleth?.timeline?.stretchClip(clipId, newDurationTicks)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error(`[SelectTool] stretchClip(${clipId}) failed:`, err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleStretchClipLeft = useCallback(async (clipId, newPositionTicks, newDurationTicks) => {
    console.log(`[SelectTool] Left-stretch clip ${clipId}: pos=${newPositionTicks}t, dur=${newDurationTicks}t`)
    try {
      const updated = await window.xleth?.timeline?.stretchClipLeft(clipId, newPositionTicks, newDurationTicks)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error(`[SelectTool] stretchClipLeft(${clipId}) failed:`, err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  // ── Drag-over (preview while dragging sample onto timeline) ────────────────

  const handleCanvasDragOver = useCallback((localX, localY, e) => {
    const types = e.dataTransfer.types
    const isSample  = types.includes('application/xleth-sample')
    const isSource  = types.includes('application/xleth-source')
    const isPattern = types.includes('application/xleth-pattern')
    if (!isSample && !isSource && !isPattern) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'

    const trackIndex = trackLayout.trackIndexAtY(localY)
    if (trackIndex < 0 || trackIndex >= visibleTracks.length) {
      dropPreviewRef.current = null
      canvasRef.current?.redrawOverlay()
      return
    }

    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const modifiers = { alt: e.altKey, shift: e.shiftKey }
    const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)

    // Read drag payload from global (can't read dataTransfer during dragover)
    const dragData = isPattern
      ? window.__xlethDragPattern
      : isSource
        ? window.__xlethDragSource
        : window.__xlethDragSample
    if (!dragData) return

    let durationBeats
    let color
    let name
    if (isPattern) {
      durationBeats = (dragData.lengthTicks || PPQ * 4) / PPQ
      const region  = regions[dragData.regionId]
      color = region ? labelHexColor(region.label || 'Custom') : tokenValue('--theme-drag-preview-default')
      name  = dragData.name
    } else if (isSource) {
      durationBeats = (dragData.duration || 0) * (bpmRef.current / 60)
      color = labelHexColor('Custom')
      name  = dragData.fileName
    } else {
      durationBeats = Math.abs(dragData.endTime - dragData.startTime) * (bpmRef.current / 60)
      color = labelHexColor(dragData.label)
      name  = dragData.name
    }

    const snapLabel = modifiers.shift ? 'free' : modifiers.alt ? '32nd' : '16th'
    console.log(`[TimelineClips] Drop preview: beat=${snappedBeat.toFixed(2)}, track=${trackIndex}, snap=${snapLabel}`)

    dropPreviewRef.current = {
      beat: snappedBeat,
      trackIndex,
      durationBeats,
      color,
      name,
    }
    canvasRef.current?.redrawOverlay()
  }, [regions, trackLayout, visibleTracks])

  // ── Drop (create clip from dropped sample) ─────────────────────────────────

  const handleCanvasDrop = useCallback(async (localX, localY, e) => {
    e.preventDefault()
    dropPreviewRef.current = null
    canvasRef.current?.redrawOverlay()

    const sourceRaw  = e.dataTransfer.getData('application/xleth-source')
    const sampleRaw  = e.dataTransfer.getData('application/xleth-sample')
    const patternRaw = e.dataTransfer.getData('application/xleth-pattern')
    if (!sourceRaw && !sampleRaw && !patternRaw) return

    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const trackIndex = trackLayout.trackIndexAtY(localY)

    if (trackIndex < 0 || trackIndex >= visibleTracks.length) {
      console.warn('[TimelineClips] WARNING: drop outside track area')
      return
    }

    const modifiers = { alt: e.altKey, shift: e.shiftKey }
    const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)
    const track = visibleTracks[trackIndex]
    const positionTicks = beatsToTicks(snappedBeat)

    // ── Pattern drop: create PatternBlock on Pattern-type track ─────────────
    // Pattern tracks are sample-agnostic — any pattern is accepted on any
    // pattern track. The block's pattern carries its own regionId.
    if (patternRaw) {
      let pd
      try { pd = JSON.parse(patternRaw) } catch { return }
      if (track.type !== 'Pattern') {
        console.warn(`[TimelineClips] Pattern drop rejected: track "${track.name}" is not a Pattern track`)
        return
      }
      const durationTicks = pd.lengthTicks || (PPQ * 4)
      try {
        const blockId = await window.xleth?.timeline?.addPatternBlock({
          trackId: track.id,
          patternId: pd.patternId,
          positionTicks,
          durationTicks,
          offsetTicks: 0,
        })
        console.log(`[TimelineClips] PatternBlock created via drag: id=${blockId}, pattern=${pd.patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      } catch (err) {
        console.error('[TimelineClips] addPatternBlock (drag) failed:', err)
      }
      return
    }

    // ── Source drop: create region + clip spanning the full source ──────────
    if (sourceRaw) {
      let src
      try { src = JSON.parse(sourceRaw) } catch { return }
      const durationTicks = regionDurationToTicks(0, src.duration || 0, bpmRef.current)
      console.log(`[TimelineClips] Source drop: "${src.fileName}" on track "${track.name}" at beat ${snappedBeat.toFixed(2)} (pos=${positionTicks}t, dur=${durationTicks}t)`)
      try {
        // The region and its clip are one drop, so they are one undo entry.
        const created = await withUndoGroup('Add source clip', async () => {
          const regionId = await window.xleth?.timeline?.addRegion({
            sourceId:  src.sourceId,
            startTime: 0,
            endTime:   src.duration || 0,
            label:     'Custom',
            name:      src.fileName,
          })
          if (typeof regionId !== 'number' || regionId < 0) {
            console.warn('[TimelineClips] addRegion returned invalid id:', regionId)
            return null
          }
          const [clipId] = await addClipsAndSplice([{
            trackId: track.id,
            regionId,
            positionTicks,
            durationTicks,
            velocity: 1.0,
          }])
          return { regionId, clipId }
        })
        if (!created) return
        console.log(`[TimelineClips] Source clip created: region=${created.regionId} clip=${created.clipId}`)
        // rebuildAudioMappings() picks up the new region and loads it into SampleBank.
        timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
      } catch (err) {
        console.error('[TimelineClips] source drop failed:', err)
      }
      return
    }

    // ── Sample drop (existing behavior) ─────────────────────────────────────
    let data
    try { data = JSON.parse(sampleRaw) } catch { return }

    // ── Pitch sample on a Pattern track → PatternBlock ─────────────────────
    // On a Clip track, a Pitch drop falls through to the regular clip path
    // below. Use the right-click "Convert to Pattern Track" menu to opt into
    // pattern/sampler behavior explicitly.
    if (data.label === 'Pitch' && track.type === 'Pattern') {
      // Find or create a pattern matching the dropped sample's region.
      // Priority: (1) current pattern for this track if regionId matches,
      // (2) any existing pattern with that regionId, (3) create new.
      let patternId = -1
      const currentPatId = currentPatternIdByTrack?.[track.id]
      if (currentPatId != null && currentPatId >= 0) {
        const p = patterns[currentPatId]
        if (p && p.regionId === data.regionId) patternId = currentPatId
      }
      if (patternId < 0) {
        const match = Object.values(patterns).find(p => p.regionId === data.regionId)
        if (match) patternId = match.id
      }
      if (patternId < 0) {
        const name = nextPatternName(data.regionId)
        try {
          const newId = await window.xleth?.timeline?.addPattern({
            name,
            regionId: data.regionId,
            lengthTicks: PPQ * 4,
          })
          if (newId != null && newId >= 0) {
            patternId = newId
            await fetchPatterns()
            timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
          }
        } catch (err) {
          console.error('[TimelineClips] addPattern failed:', err)
          return
        }
      }
      if (patternId < 0) {
        console.warn('[TimelineClips] No pattern available for block creation')
        return
      }
      setCurrentPatternIdByTrack(prev => ({ ...prev, [track.id]: patternId }))

      // Create a PatternBlock at drop position — duration = one pattern loop
      const pattern = patterns[patternId]
      const durationTicks = pattern?.lengthTicks || (PPQ * 4)
      try {
        const blockId = await window.xleth?.timeline?.addPatternBlock({
          trackId: track.id,
          patternId,
          positionTicks,
          durationTicks,
          offsetTicks: 0,
        })
        console.log(`[TimelineClips] PatternBlock created: id=${blockId}, pattern=${patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      } catch (err) {
        console.error('[TimelineClips] addPatternBlock failed:', err)
      }
      return
    }

    // ── Non-pitch sample → Clip (existing behavior) ────────────────────────
    const durationTicks = regionDurationToTicks(data.startTime, data.endTime, bpmRef.current)

    console.log(`[TimelineClips] Clip created via drop: "${data.name}" on track "${track.name}" at beat ${snappedBeat.toFixed(2)} (pos=${positionTicks}t, dur=${durationTicks}t)`)

    try {
      const [clipId] = await addClipsAndSplice([{
        trackId: track.id,
        regionId: data.regionId,
        positionTicks,
        durationTicks,
        velocity: 1.0,
      }])
      console.log(`[TimelineClips] Clip created: id=${clipId}`)
    } catch (err) {
      console.error('[TimelineClips] addClip failed:', err)
    }
  }, [visibleTracks, trackLayout, addClipsAndSplice, fetchPatterns, patterns, currentPatternIdByTrack, nextPatternName, setCurrentPatternIdByTrack, withUndoGroup])

  // ── Drag leave (clear preview) ─────────────────────────────────────────────

  const handleCanvasDragLeave = useCallback((e) => {
    // Only clear if leaving the canvas container (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget)) return
    dropPreviewRef.current = null
    canvasRef.current?.redrawOverlay()
    console.log('[TimelineClips] Drop preview cleared')
  }, [])

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  //
  // Routed through the central KeyboardManager — the router gates on focused
  // panel + text-entry, so the inline checks for activeCenterTab and INPUT/
  // TEXTAREA target are gone. Handler is held in a ref so state changes don't
  // re-register; the registration useEffect is empty-deps and runs once.

  // Syllables the digit keys can pick: only with the Pencil on a Quote sample.
  const pencilQuoteSyllables = () => {
    if (activeTool !== 'pencil') return []
    const tmpl = pencilTemplateRef.current
    const regionId = tmpl ? tmpl.regionId : activeSampleId
    const region = regionId != null ? regions[regionId] : null
    return region?.label === 'Quote' ? getSelectableSyllables(region.syllables) : []
  }

  // Whether a command has anything to act on right now. A command that does
  // not apply leaves the key unclaimed, so it can still reach whoever else
  // binds it (Ctrl+minus with no clip selected is the window zoom).
  const timelineKeyCommandApplies = (command) => {
    switch (command.id) {
      case 'delete':
        return selectedClipIds.size > 0 || selectedBlockIds.size > 0
          || selectedAutomationClipIds.size > 0 || Boolean(selectedAutomationPoint)
      case 'toggleLoop': return selectedBlockIds.size > 0
      case 'pitch': return selectedClipIds.size > 0
      case 'syllable': return pencilQuoteSyllables().length > 0
      default: return true
    }
  }

  // Everything an undo or redo can have touched.
  //
  // Tracks and clips are requested together, so the two reads reach the engine
  // back to back instead of one waiting on the other's reply. Pattern blocks and
  // automation are NOT fetched here: the events below already make this
  // component's own listeners refetch them (the same events the Piano Roll, the
  // mixer and the automation store follow), so fetching them here as well did
  // each of those reads twice per keypress.
  const refreshAfterHistoryStep = async () => {
    const core = Promise.all([fetchTracks(), fetchClips()])
    timelineEvents.dispatchEvent(new Event('timeline-track-layout-changed'))
    timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    // Pattern notes are undo-tracked too, note Lens overrides (Nudge / Own keys)
    // included: without this Motion view and the Edit header's motion marker
    // keep drawing an undone override.
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    // Automation lanes/clips/envelopes are undo-tracked too — without this an
    // undone point edit stays on the canvas (and, worse, the canvas hit-tests
    // against points the engine no longer has).
    timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
    await core
  }

  const runTimelineKeyCommand = async (command) => {
      // ── View switch and graph (R20) ───────────────────────────────────
      if (command.id === 'toggleView') {
        useMotionViewStore.getState().toggleView()
        return
      }
      if (command.id === 'toggleGraph') {
        useMotionViewStore.getState().toggleGraph()
        return
      }

      // ── Undo / Redo (global, no focus gate) ───────────────────────────
      if (command.id === 'undo') {
        // One entry per press. A gesture made of several engine calls is one
        // entry already (see withUndoGroup).
        await window.xleth?.undo?.undo()
        console.log('[Keyboard] Undo')
        await refreshAfterHistoryStep()
        return
      }
      if (command.id === 'redo') {
        await window.xleth?.undo?.redo()
        console.log('[Keyboard] Redo')
        await refreshAfterHistoryStep()
        return
      }

      // ── Select all (global) ───────────────────────────────────────────
      if (command.id === 'selectAll') {
        setSelectedClipIds(new Set(clipsRef.current.map((c) => c.id)))
        // Pattern blocks are timeline items like any other: Select All used to
        // skip them, so Ctrl+A then Delete (or a drag) left every block behind.
        setSelectedBlockIds(new Set((patternBlocksRef.current ?? []).map((b) => b.id)))
        setSelectedAutomationClipIds(new Set((automationClipsRef.current ?? []).map((c) => c.id)))
        console.log('[Keyboard] Select all')
        return
      }

      // ── Delete selected clips + blocks + automation (parallel) ────────
      // The automation selections belong in this gate too: without them Delete
      // never reaches deleteSelectedTimelineItems when the only thing selected
      // is an automation clip (Phase B) or an envelope point (Phase C).
      if (command.id === 'delete') {
        await deleteSelectedTimelineItems()
        return
      }

      // ── Cut / Copy clips + pattern blocks (Ctrl+X / Ctrl+C) ──────────
      if (command.id === 'copy' || command.id === 'cut') {

        const next = buildTimelineClipboard({
          clips: clipsRef.current.filter(c => selectedClipIds.has(c.id)),
          patternBlocks: patternBlocks.filter(b => selectedBlockIds.has(b.id)),
          automationClips: automationClips.filter(c => selectedAutomationClipIds.has(c.id)),
          tracks: visibleTracks,
        })
        if (!next.clips && !next.patternBlocks && !next.automationClips) return

        clipboardRef.current = next
        const nClips = next.clips?.length ?? 0
        const nBlocks = next.patternBlocks?.length ?? 0
        const nAuto = next.automationClips?.length ?? 0
        if (command.id === 'cut') {
          await deleteSelectedTimelineItems()
          console.log(`[Keyboard] Cut ${nClips} clip(s), ${nBlocks} pattern block(s), ${nAuto} automation clip(s)`)
        } else {
          console.log(`[Keyboard] Copied ${nClips} clip(s), ${nBlocks} pattern block(s), ${nAuto} automation clip(s)`)
        }
        return
      }

      // ── Paste clips + pattern blocks at edit cursor (Ctrl+V) ─────────
      //
      // The group is rigid: it lands at (edit cursor, focused track) with every
      // internal tick and track offset preserved, and OVERWRITES whatever it
      // covers. The clip half is a single atomic pasteClipsBatch, so a 200-clip
      // paste is ONE round trip and ONE undo entry instead of 200 of each.
      if (command.id === 'paste') {

        const cb = clipboardRef.current
        if (!cb || (!cb.clips && !cb.patternBlocks && !cb.automationClips)) return

        // Read the edit cursor exactly — it may be off-grid after playback or
        // free seeking, and paste should not quantize it back to 1/16.
        const baseTicks = beatsToTicks(Math.max(0, editCursor.getPosition()))
        const focusIdx = visibleTracks.findIndex(t => t.id === focusedTrackIdRef.current)

        const { clipPlacements, blockPlacements, automationPlacements, skipped } = resolveTimelinePaste({
          clipboard: cb,
          baseTicks,
          targetTrackIndex: focusIdx >= 0 ? focusIdx : cb.anchorTrackIndex,
          tracks: visibleTracks,
        })
        // Automation clips snap their landing tick to the current grid, same
        // as every other automation-lane interaction — unlike the clip/block
        // paste above, which preserves the edit cursor's exact position.
        for (const p of automationPlacements) {
          p.positionTicks = snapTickToGrid(p.positionTicks, {}, snapGranularity)
        }

        // Advance the edit cursor IMMEDIATELY so held/spammed Ctrl+V stacks
        // forward instead of re-pasting onto the same spot.
        const endTicks = placementsEndTick(baseTicks, clipPlacements, blockPlacements, automationPlacements)
        handleSeek(endTicks / PPQ)

        // Everything from here on reads the CURRENT clip/block lists to decide
        // what the group buries, so it queues behind any paste still in flight.
        // The cursor advance above stays synchronous — held Ctrl+V must keep
        // stacking forward even while the engine is still catching up.
        await runSerializedEdit(async () => {
          const xl = window.xleth?.timeline
          try {
            const { doomedClipIds: doomedClips, doomedBlockIds: doomedBlocks } = resolveOverwritePlan({
              existingClips: clipsRef.current,
              existingBlocks: patternBlocksRef.current,
              clipPlacements,
              blockPlacements,
            })

            // ── Clips: overwrite + insert, atomically ───────────────────────
            if (clipPlacements.length > 0 || doomedClips.length > 0) {
              const payloads = clipPlacements.map(p =>
                clipPayloadFromSnapshot(p.item, p.trackId, p.positionTicks))
              const res = await xl?.pasteClipsBatch({
                removeClipIds: doomedClips,
                clips: payloads,
              })
              applyClipDelta({ updated: res?.clips ?? [], removed: res?.removedIds ?? [] })
              setSelectedClipIds(new Set(res?.newIds ?? []))
            }

            // ── Pattern blocks: overwrite + insert, atomically ──────────────
            // This was a SERIAL for-loop of awaited addPatternBlock plus a
            // second awaited setPatternBlockLoop per looped block — a 64-block
            // paste was 64+ stacked round trips and 64+ undo entries. The drag
            // paths had been pipelined with Promise.all; the keyboard paths
            // never were. Now one round trip, one undo entry, loopEnabled
            // carried on the block itself.
            if (blockPlacements.length > 0 || doomedBlocks.length > 0) {
              const res = await xl?.pastePatternBlocksBatch({
                removeBlockIds: doomedBlocks,
                blocks: blockPlacements.map(p => ({
                  trackId: p.trackId,
                  patternId: p.item.patternId,
                  positionTicks: p.positionTicks,
                  durationTicks: p.item.durationTicks,
                  offsetTicks: p.item.offsetTicks ?? 0,
                  loopEnabled: p.item.loopEnabled ?? false,
                })),
              })
              applyPatternBlockDelta({ updated: res?.blocks ?? [], removed: res?.removedIds ?? [] })
              timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
              setSelectedBlockIds(new Set((res?.blocks ?? []).map(b => b.id)))
            }

            // Automation clips: the engine REJECTS same-lane overlap outright
            // (no overwrite semantics like clips/blocks above). Copies share the
            // source's envelopeId — no addEnvelope call, per FL semantics.
            if (automationPlacements.length > 0) {
              // Resolved ENGINE-side, in one batch. Each landing tick depends on
              // the placements before it, so this loop could never be a
              // client-side Promise.all — which is exactly why it stayed a
              // serial await-per-clip with a running occupancy map here.
              // AddAutomationClipsBatchCommand keeps that dependency and makes
              // the whole group one round trip and one undo entry.
              const landed = await window.xleth?.automation?.addClipsBatch(
                automationPlacements.map(p => ({
                  laneId: p.laneId,
                  envelopeId: p.item.envelopeId,
                  positionTicks: p.positionTicks,
                  durationTicks: p.durationTicks,
                  offsetTicks: p.item.offsetTicks ?? 0,
                })))
              await fetchAutomationClips()
              timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
              setSelectedAutomationClipIds(new Set((landed ?? []).map(c => c.id)))
            }
            console.log(`[Keyboard] Pasted ${clipPlacements.length} clip(s) + `
              + `${blockPlacements.length} block(s) + ${automationPlacements.length} automation clip(s) `
              + `at ${baseTicks}t (overwrote ${doomedClips.length + doomedBlocks.length}), cursor → ${endTicks}t`)
          } catch (err) {
            console.error('[Keyboard] Paste failed:', err)
          }
        })

        const messages = []
        if (skipped.typeMismatchClip > 0) {
          const n = skipped.typeMismatchClip
          messages.push(`${n} clip${n === 1 ? '' : 's'} skipped — no Clip track at that offset`)
        }
        if (skipped.typeMismatchBlock > 0) {
          const n = skipped.typeMismatchBlock
          messages.push(`${n} pattern block${n === 1 ? '' : 's'} skipped — no Pattern track at that offset`)
        }
        if (messages.length > 0) showToast(messages.join(' · '), 'info')
        return
      }

      // ── Duplicate selection after itself (Ctrl+D) ────────────────────
      //
      // Duplicates the WHOLE selection, shifted right by the selection's own
      // span, so a copied phrase repeats seamlessly. It used to duplicate only
      // the first selected clip and slide it to the nearest free slot.
      if (command.id === 'duplicate') {
        // Reading the sources and resolving the overwrite plan both queue: a
        // held Ctrl+D otherwise duplicates from a list the previous repeat has
        // not written back yet, and buries the wrong items.
        await runSerializedEdit(async () => {
          const srcClips = clipsRef.current.filter(c => selectedClipIds.has(c.id))
          const srcBlocks = patternBlocksRef.current.filter(b => selectedBlockIds.has(b.id))
          const srcAutomation = automationClipsRef.current.filter(c => selectedAutomationClipIds.has(c.id))
          if (srcClips.length === 0 && srcBlocks.length === 0 && srcAutomation.length === 0) return

          const all = [...srcClips, ...srcBlocks, ...srcAutomation]
          const spanStart = Math.min(...all.map(i => i.positionTicks))
          const spanEnd = Math.max(...all.map(i => i.positionTicks + i.durationTicks))
          const shift = spanEnd - spanStart
          const xl = window.xleth?.timeline

          // Same overwrite policy as paste and drag: a shifted copy buries what
          // it lands on instead of stacking on it. The shift is the selection's
          // own span, so the copies always clear their own sources — but a sparse
          // selection can still land a copy on an untouched item, and that goes.
          const { doomedClipIds, doomedBlockIds } = resolveOverwritePlan({
            existingClips: clipsRef.current,
            existingBlocks: patternBlocksRef.current,
            clipPlacements: srcClips.map(c => ({
              trackId: c.trackId, positionTicks: c.positionTicks + shift, durationTicks: c.durationTicks,
            })),
            blockPlacements: srcBlocks.map(b => ({
              trackId: b.trackId, positionTicks: b.positionTicks + shift, durationTicks: b.durationTicks,
            })),
          })

          try {
            if (srcClips.length > 0 || doomedClipIds.length > 0) {
              const payloads = srcClips.map(c =>
                clipPayloadFromSnapshot(c, c.trackId, c.positionTicks + shift))
              // pasteClipsBatch, not addClipsBatch — overwrite + insert as ONE
              // undo entry, so Ctrl+Z cannot leave the buried clips deleted.
              const res = await xl?.pasteClipsBatch({
                removeClipIds: doomedClipIds,
                clips: payloads,
              })
              applyClipDelta({ updated: res?.clips ?? [], removed: res?.removedIds ?? [] })
              setSelectedClipIds(new Set(res?.newIds ?? []))
            }
            if (srcBlocks.length > 0 || doomedBlockIds.length > 0) {
              // One atomic overwrite+insert, same as the paste path above — this
              // was a serial add-per-block plus a setPatternBlockLoop each.
              const res = await xl?.pastePatternBlocksBatch({
                removeBlockIds: doomedBlockIds,
                blocks: srcBlocks.map(b => ({
                  trackId: b.trackId,
                  patternId: b.patternId,
                  positionTicks: b.positionTicks + shift,
                  durationTicks: b.durationTicks,
                  offsetTicks: b.offsetTicks ?? 0,
                  loopEnabled: b.loopEnabled ?? false,
                })),
              })
              applyPatternBlockDelta({ updated: res?.blocks ?? [], removed: res?.removedIds ?? [] })
              timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
              setSelectedBlockIds(new Set((res?.blocks ?? []).map(b => b.id)))
            }
            if (srcAutomation.length > 0) {
              // Same-lane overlap is engine-rejected, so each duplicate's shifted
              // landing tick is snapped to grid here and then RESOLVED ENGINE-SIDE
              // against the lane's existing clips and any earlier duplicate this
              // same Ctrl+D placed. The snap is a UI decision and stays local; the
              // free-slot search depends on the placements before it and so
              // belongs in the batch (AddAutomationClipsBatchCommand) — that
              // dependency is what kept this a serial await-per-clip loop.
              const landed = await window.xleth?.automation?.addClipsBatch(
                srcAutomation.map(c => ({
                  laneId: c.laneId,
                  envelopeId: c.envelopeId,
                  positionTicks: snapTickToGrid(c.positionTicks + shift, {}, snapGranularity),
                  durationTicks: c.durationTicks,
                  offsetTicks: c.offsetTicks ?? 0,
                })))
              await fetchAutomationClips()
              timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
              setSelectedAutomationClipIds(new Set((landed ?? []).map(c => c.id)))
            }
            handleSeek((spanEnd + shift) / PPQ)
            console.log(`[Keyboard] Duplicated ${srcClips.length} clip(s) + `
              + `${srcBlocks.length} block(s) + ${srcAutomation.length} automation clip(s) by ${shift}t `
              + `(overwrote ${doomedClipIds.length + doomedBlockIds.length})`)
          } catch (err) {
            console.error('[Keyboard] Duplicate failed:', err)
          }
        })
        return
      }

      // ── Toggle pattern-block loop (L) ─────────────────────────────────
      if (command.id === 'toggleLoop') {
        const ids = [...selectedBlockIds]
        // Determine new state from the first selected block's current loopEnabled
        // (treat undefined as true for backward compat) — toggle to the opposite,
        // then apply uniformly to all selected blocks so they stay in sync.
        const first = patternBlocks.find(b => b.id === ids[0])
        const nextEnabled = !((first?.loopEnabled ?? true))
        try {
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.setPatternBlockLoop(id, nextEnabled)
              .catch(err => console.error(`[Keyboard] setPatternBlockLoop(${id}) failed:`, err))
          ))
          await fetchPatternBlocks()
          timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
          console.log(`[Keyboard] Toggled loop → ${nextEnabled} on ${ids.length} block(s)`)
        } catch (err) {
          console.error('[Keyboard] Loop toggle failed:', err)
        }
        return
      }

      // ── Pitch shift selected clips (+/- keys) ────────────────────────
      if (command.id === 'pitch') {
        const { direction, semitones: semis, cents, unit } = command
        const ids = [...selectedClipIds]
        // Shift +/- = ±12 semitones (one octave); Ctrl +/- = ±1 cent; bare = ±1 semitone.
        // pitchShiftClip answers with the clip's post-state, so the whole
        // selection reconciles from the replies — no getClips over the project.
        // One call per clip, one undo entry for the selection.
        const shifted = await withUndoGroup('Pitch shift', () => Promise.all(ids.map(id =>
          window.xleth?.timeline?.pitchShiftClip(id, semis, cents)
            .catch(err => {
              console.error(`[Keyboard] pitchShiftClip(${id}) failed:`, err)
              return null
            })
        )))
        applyClipDelta({ updated: shifted.filter(Boolean) })
        console.log(`[Keyboard] Pitch ${direction > 0 ? '+' : '-'}${unit} on ${ids.length} clip(s)`)
        return
      }

      // ── Tools ─────────────────────────────────────────────────────────
      // S splits the selection at the playhead when there is one to split,
      // and is the Select tool otherwise.
      if (command.id === 'splitOrSelect') {
        const splitTick = beatsToTicks(playheadBeatRef.current)
        if (await handleSpliceSelectedClips(splitTick)) return
        setActiveTool('select')
        console.log('[Keyboard] Tool → select')
        return
      }
      if (command.id === 'tool') {
        setActiveTool(command.tool)
        console.log(`[Keyboard] Tool → ${command.tool}`)
        return
      }

      // ── Syllable pick (1-9) when pencil + Quote with syllables is active ─
      if (command.id === 'syllable') {
        const selected = pencilQuoteSyllables()[command.index]
        if (selected) {
          handleSelectSyllable(selected.sourceIndex)
          console.log(`[Keyboard] Syllable → ${command.index + 1}`)
        }
      }
  }

  // The one entry point for a key the router sends here. It decides whether
  // the key is the timeline's and claims it BEFORE any await: the router reads
  // the answer the moment this returns, so a claim made after an engine round
  // trip (as S used to make it) arrived too late and the key was also offered
  // to the next panel. Whether the timeline should get the key at all is the
  // router's decision alone; there is no second focus check in here.
  const timelineKeyHandlerRef = useRef(null)
  timelineKeyHandlerRef.current = (e) => {
    const command = resolveTimelineKeyCommand(e)
    // Which view the key belongs to (R20): Motion view sends the key edits to its
    // own handle and ignores the clip tools; the Edit view leaves the Motion-only
    // keys (G, arrows, Escape, Backspace) unclaimed.
    const route = timelineCommandRoute(command, timelineViewNameRef.current)
    if (!route) return false
    if (route === 'motion') {
      if (motionViewRef.current?.handleKeyCommand(command) !== true) return false
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (route === 'edit' && !timelineKeyCommandApplies(command)) return false
    e.preventDefault()
    if (!TIMELINE_PASSTHROUGH_COMMANDS.has(command.id)) e.stopPropagation()
    runTimelineKeyCommand(command)
      .catch((err) => console.error(`[Keyboard] ${command.id} failed:`, err))
    return true
  }

  // Edit > Undo / Redo run the same command as the keys, so the menu also pops
  // a compound edit whole and refreshes the same lists.
  const runTimelineKeyCommandRef = useRef(runTimelineKeyCommand)
  runTimelineKeyCommandRef.current = runTimelineKeyCommand
  useEffect(() => {
    const unregister = ['undo', 'redo'].map((id) =>
      registerEditorCommand('timeline', id, () => runTimelineKeyCommandRef.current({ id })))
    return () => { unregister.forEach((u) => u()) }
  }, [])

  useEffect(() => {
    const dispatch = (e) => (timelineKeyHandlerRef.current?.(e) ? 'handled' : undefined)
    const unsubscribers = [
      ...TIMELINE_KEY_COMBOS.map((combo) =>
        registerKeyboardBinding({ scope: 'panel:timeline', combo, handler: dispatch })),
      // Undo and redo act on the project's one undo stack, so they also answer
      // when the mouse and the last click are on a panel with no undo of its
      // own (Inspector, Preview, Mixer, Browser). A panel that has one (Piano
      // Roll, FX Graph, Sample Sandbox) is asked first and keeps the key.
      ...TIMELINE_GLOBAL_KEY_COMBOS.map((combo) =>
        registerKeyboardBinding({ scope: 'global', combo, handler: dispatch })),
    ]
    return () => { unsubscribers.forEach((u) => u()) }
  }, [])

  // ── Context menu ───────────────────────────────────────────────────────────

  const handleAutoTrimClip = useCallback(async (clipId) => {
    try {
      const result = await window.xleth.timeline.autoTrimClip(clipId, -54)
      console.log('[Timeline] Auto-Trim result:', result)
      if (!result?.success) {
        console.warn('[Timeline] Auto-Trim failed:', result?.reason)
        return
      }
      if (result.clip) applyClipDelta({ updated: [result.clip] })
      else if (result.trimmed) await fetchClips()   // an engine without post-state
    } catch (err) {
      console.error('[Timeline] Auto-Trim error:', err)
    }
  }, [fetchClips, applyClipDelta])

  const handleReverseClip = useCallback(async (clipId) => {
    try {
      const updated = await window.xleth.timeline.reverseClip(clipId)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] reverseClip error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleSetClipStretchMethod = useCallback(async (clipId, method) => {
    console.log(`[UIStretch] setClipStretchMethod: clip=${clipId} method=${method}`)
    try {
      const updated = await window.xleth.timeline.setClipParams(clipId, { stretchMethod: method })
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipStretchMethod error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleSetClipFormantPreserve = useCallback(async (clipId, enabled) => {
    console.log(`[UIStretch] setClipFormantPreserve: clip=${clipId} enabled=${enabled}`)
    try {
      const updated = await window.xleth.timeline.setClipParams(clipId, { formantPreserve: enabled })
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipFormantPreserve error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleSetClipVelocity = useCallback(async (clipId, velocity) => {
    try {
      const updated = await window.xleth.timeline.setClipParams(clipId, { velocity })
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipVelocity error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const mergeReturnedClip = useCallback((updated) => {
    if (updated?.id == null) return
    applyClipDelta({ updated: [updated] })
  }, [applyClipDelta])

  const handleBeginClipControlEdit = useCallback((clipId) => (
    window.xleth.timeline.beginClipControlEdit(clipId)
  ), [])

  const handlePreviewClipControlEdit = useCallback(async (sessionId, patch) => {
    // The canvas owns the visual draft. Avoid merging preview replies into React
    // state because an already-sent frame may resolve after a final commit.
    return window.xleth.timeline.previewClipControlEdit(sessionId, patch)
  }, [])

  const handleCommitClipControlEdit = useCallback(async (sessionId, finalPatch) => {
    const updated = await window.xleth.timeline.commitClipControlEdit(sessionId, finalPatch)
    mergeReturnedClip(updated)
    return updated
  }, [mergeReturnedClip])

  const handleCancelClipControlEdit = useCallback(async (sessionId) => {
    const restored = await window.xleth.timeline.cancelClipControlEdit(sessionId)
    mergeReturnedClip(restored)
    return restored
  }, [mergeReturnedClip])

  const handleSetClipVibrato = useCallback(async (clipId, vibratoPatch) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      const merged = mergeClipModulationPatch(clip, {
        vibratoPatch,
        forceEnabled: vibratoPatch.enabled === true,
      })
      const updated = await window.xleth.timeline.setClipModulation(clipId, merged)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipVibrato error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleSetClipScratch = useCallback(async (clipId, scratchPatch, options = {}) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      const existingScratch = clip?.modulation?.scratch ?? {}
      let nextPatch = scratchPatch
      let forceEnabled = false

      if (options.presetKey) {
        nextPatch = {
          ...scratchPatch,
          ...scratchPresetPatch(options.presetKey, {
            scratchCount: options.scratchCount,
            lengthBeats: options.lengthBeats,
          }),
        }
        forceEnabled = true
      } else if (scratchPatch.enabled === true) {
        const hasCurve = Array.isArray(existingScratch.curve) && existingScratch.curve.length > 0
        nextPatch = hasCurve
          ? scratchPatch
          : {
              ...scratchPatch,
              timeMode: SCRATCH_PRESETS[0].timeMode,
              curve: cloneScratchCurve(SCRATCH_PRESETS[0].curve),
            }
        forceEnabled = true
      }

      const merged = mergeClipModulationPatch(clip, {
        scratchPatch: nextPatch,
        forceEnabled,
      })
      const updated = await window.xleth.timeline.setClipModulation(clipId, merged)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipScratch error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleSetClipVideoFx = useCallback(async (clipId, videoPatch) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      // Switching a companion FX off -> on seeds its numbers from the user's
      // Settings > Clip FX defaults, but only while the clip still holds the
      // engine's stock values: a clip whose Swirl was dialled in by hand keeps
      // that number when it is toggled off and back on.
      const seeded = seedVideoFxDefaults(clip?.modulation?.video, videoPatch)
      const merged = mergeClipModulationPatch(clip, { videoPatch: seeded })
      const updated = await window.xleth.timeline.setClipModulation(clipId, merged)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipVideoFx error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  const handleSetClipFade = useCallback(async (clipId, fadeParams) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      let payload = fadeParams
      if (clip && ('fadeInPercent' in fadeParams || 'fadeOutPercent' in fadeParams)) {
        const next = normalizeFadePercents(
          fadeParams.fadeInPercent ?? clipFadePercent(clip, 'in'),
          fadeParams.fadeOutPercent ?? clipFadePercent(clip, 'out')
        )
        payload = {
          ...fadeParams,
          ...next,
          fadeInTicks: Math.round((next.fadeInPercent / 100) * (clip.durationTicks ?? 0)),
          fadeOutTicks: Math.round((next.fadeOutPercent / 100) * (clip.durationTicks ?? 0)),
        }
      }
      const updated = await window.xleth.timeline.setClipParams(clipId, payload)
      applyClipDelta({ updated: updated ? [updated] : [] })
    } catch (err) {
      console.error('[Timeline] setClipFade error:', err)
      await fetchClips()
    }
  }, [fetchClips, applyClipDelta])

  // Phase G.4: auto-close the quick FX menu if its clip is no longer present
  useEffect(() => {
    if (!quickFxMenu) return
    if (!clips.find(c => c.id === quickFxMenu.clipId)) {
      setQuickFxMenu(null)
    }
  }, [clips, quickFxMenu])

  const closeClipContextMenu = useCallback(() => {
    setContextMenu(null)
    requestAnimationFrame(() => {
      const activeElement = document.activeElement
      if (isInteractiveFocusElement(activeElement)) return
      if (!usePanelRegistry.getState().panels.timeline.focused) return

      focusTimelinePanel('timeline')

      const timelinePanel = timelineViewRef.current?.closest?.('[data-panel-id="timeline"]')
      if (timelinePanel instanceof HTMLElement) {
        timelinePanel.focus()
      } else if (timelineViewRef.current instanceof HTMLElement) {
        timelineViewRef.current.focus()
      }

      if (usePianoRollStore.getState().activeCenterTab !== 'timeline') {
        usePianoRollStore.getState().setActiveCenterTab('timeline')
      }
    })
  }, [focusTimelinePanel])

  const contextMenuClip = contextMenu?.type === 'clip'
    ? clipsRef.current.find(c => c.id === contextMenu.clipId)
    : null

  // ── Inspector: publish the arrangement's selection ────────────────────────
  // Selection stays local (the canvas tools own it); the Inspector, in another
  // panel, follows it through useInspectorStore. Whichever set changed last wins.
  const setInspectorSelection = useInspectorStore((st) => st.setSelection)
  const setInspectorClip = useInspectorStore((st) => st.setClipContext)
  const setInspectorClipActions = useInspectorStore((st) => st.setClipActions)
  const trackSelectRequest = useInspectorStore((st) => st.trackSelectRequest)
  const prevSelectionSetsRef = useRef(null)
  useEffect(() => {
    const prev = prevSelectionSetsRef.current
    prevSelectionSetsRef.current = { clips: selectedClipIds, blocks: selectedBlockIds, tracks: selectedTrackIds }
    let changed = null
    if (prev) {
      if (prev.tracks !== selectedTrackIds && selectedTrackIds.size > 0) changed = 'tracks'
      if (prev.blocks !== selectedBlockIds && selectedBlockIds.size > 0) changed = 'blocks'
      if (prev.clips !== selectedClipIds && selectedClipIds.size > 0) changed = 'clips'
    }
    setInspectorSelection(deriveInspectorSelection({
      clipIds: selectedClipIds,
      blockIds: selectedBlockIds,
      trackIds: selectedTrackIds,
      changed,
      trackIdOfClip: (id) => clipsRef.current.find((c) => c.id === id)?.trackId ?? null,
      blockInfo: (id) => {
        const block = patternBlocksRef.current.find((b) => b.id === id)
        if (!block) return null
        const regionId = patternsRef.current[block.patternId]?.regionId
        return { trackId: block.trackId, patternId: block.patternId, regionId: regionId >= 0 ? regionId : null }
      },
    }))
  }, [selectedClipIds, selectedBlockIds, selectedTrackIds, setInspectorSelection])

  // Requests from outside the arrangement (the Preview's layer list).
  useEffect(() => {
    if (!trackSelectRequest) return
    setSelectedTrackIds(new Set([trackSelectRequest.trackId]))
    setSelectedClipIds(new Set())
    setSelectedBlockIds(new Set())
  }, [trackSelectRequest])

  // The single selected clip's data, refreshed with every clip fetch.
  const inspectorClipId = selectedClipIds.size === 1 ? [...selectedClipIds][0] : null
  useEffect(() => {
    if (inspectorClipId == null) { setInspectorClip(null); return }
    const clip = clips.find((c) => c.id === inspectorClipId)
    if (!clip) { setInspectorClip(null); return }
    const region = regions[clip.regionId] ?? null
    const source = region ? sources[region.sourceId] ?? null : null
    const trackIndex = tracks.findIndex((t) => t.id === clip.trackId)
    const track = trackIndex >= 0 ? tracks[trackIndex] : null
    const palette = trackIndex >= 0 ? resolveTimelinePalette().trackPalette : null
    const trackColor = track
      ? resolveAutoTrackColor(track, trackIndex, palette, TRACK_PALETTE_FALLBACK[trackIndex % 16])
      : null
    setInspectorClip({ clip, region, source, track, trackColor })
  }, [inspectorClipId, clips, regions, sources, tracks, setInspectorClip])

  // The arrangement's own clip setters, unchanged: same RPCs as the old menu.
  useEffect(() => {
    setInspectorClipActions({
      globalStretchMethod,
      reverse: handleReverseClip,
      setStretchMethod: handleSetClipStretchMethod,
      setFormantPreserve: handleSetClipFormantPreserve,
      setVibrato: handleSetClipVibrato,
      setScratch: handleSetClipScratch,
      setVideoFx: handleSetClipVideoFx,
    })
  }, [globalStretchMethod, handleReverseClip, handleSetClipStretchMethod, handleSetClipFormantPreserve,
    handleSetClipVibrato, handleSetClipScratch, handleSetClipVideoFx, setInspectorClipActions])
  useEffect(() => () => {
    setInspectorClipActions(null)
    setInspectorClip(null)
  }, [setInspectorClipActions, setInspectorClip])

  const openClipInInspector = useCallback((clipId) => {
    setSelectedClipIds(new Set([clipId]))
    setSelectedBlockIds(new Set())
    revealInspector()
  }, [])

  const contextMenuItems = contextMenu
    ? (contextMenu.type === 'patternBlock'
        ? [
            { label: 'Make Unique Copy', onClick: () => { handleMakeUniquePatternBlock(contextMenu.blockId); closeClipContextMenu() } },
            { type: 'separator' },
            { label: 'Delete', danger: true, onClick: () => { handleDeletePatternBlock(contextMenu.blockId); closeClipContextMenu() } },
          ]
        : contextMenu.type === 'automationClip'
        ? [
            { label: 'Make Unique Copy', onClick: () => { handleMakeUniqueAutomationClip(contextMenu.clipId); closeClipContextMenu() } },
            { label: 'Loop to Edit Cursor', onClick: () => { handleLoopAutomationClips(contextMenu.clipId); closeClipContextMenu() } },
            { type: 'separator' },
            { label: 'Delete', danger: true, onClick: () => { handleDeleteAutomationClip(contextMenu.clipId); closeClipContextMenu() } },
          ]
        : contextMenu.type === 'clip'
        ? [
            { label: 'Auto-Trim Silence (−54 dB)', onClick: () => handleAutoTrimClip(contextMenu.clipId) },
            { type: 'separator' },
            {
              label: 'Reverse',
              checked: !!contextMenuClip?.reversed,
              onClick: () => handleReverseClip(contextMenu.clipId),
            },
            { type: 'separator' },
            // Stretch method, formant and clip modulation live in the Inspector.
            { label: 'Properties…', onClick: () => { openClipInInspector(contextMenu.clipId); closeClipContextMenu() } },
            { type: 'separator' },
            { label: 'Delete', danger: true, onClick: () => handleDeleteClip(contextMenu.clipId) },
          ]
        : [
            { label: 'Rename', onClick: () => { /* focus rename */ } },
            { label: 'Duplicate', onClick: () => handleAddTrack() },
            { type: 'separator' },
            { label: 'Delete Track', danger: true, onClick: () => handleRemove(contextMenu.trackId) },
          ])
    : []

  // ── Centre-tab claim ───────────────────────────────────────────────────────
  // Which panel gets a key is the keyboard router's call; nothing here gates a
  // shortcut. This only keeps the legacy activeCenterTab flag in step.

  useEffect(() => {
    const onMouseDown = (e) => {
      const inTimeline = !!timelineViewRef.current?.contains(e.target)
      // Scenario A: user clicks into timeline while piano roll was active.
      // Claim activeCenterTab so the keyboard gate at line 1791 passes through.
      // TODO: remove when central keyboard router replaces activeCenterTab —
      // trigger: when unified keyboard-focus router lands and line 1791 is gone.
      if (inTimeline && usePianoRollStore.getState().activeCenterTab !== 'timeline')
        usePianoRollStore.getState().setActiveCenterTab('timeline')
    }
    window.addEventListener('mousedown', onMouseDown, true)
    return () => window.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="timeline-view" ref={timelineViewRef} tabIndex={-1}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <TimelineToolbar
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        activeSampleId={activeSampleId}
        regions={regions}
        snapGranularity={snapGranularity}
        onSnapGranularityChange={setSnapGranularity}
        pixelsPerBeat={pixelsPerBeat}
        viewportWidth={canvasWidth}
        onAddTrack={handleAddTrackClick}
        onAddFolder={handleAddFolder}
        selectedTrackCount={selectedTrackIds.size}
        pencilTemplate={pencilTemplate}
        onSelectSyllable={handleSelectSyllable}
        onOpenQuantize={() => setQuantizeOpen(true)}
        quantizeSelectionCount={selectedClipIds.size + selectedBlockIds.size}
        onOpenQuickNotation={handleOpenQuickNotation}
        view={timelineView}
        onViewChange={(v) => useMotionViewStore.getState().setView(v)}
        graph={motionGraph}
        onGraphChange={(g) => useMotionViewStore.getState().setGraph(g)}
      />

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="timeline-body" ref={timelineBodyRef}>
        {headerDragLineX !== null && (
          <div className="timeline-header-drag-line" style={{ left: headerDragLineX }} />
        )}
        {/* The arrangement keeps its structure with no tracks: ruler, header
            column with two ghost rows, the canvas (and its drop target). */}
        <>
            {/* Left-most: pattern list (FL-style strip) */}
            <PatternListPanel
              patterns={patterns}
              tracks={tracks}
              blocks={patternBlocks}
              collapsed={patternListCollapsed}
              onToggleCollapsed={() => setPatternListCollapsed(v => !v)}
              onOpenPianoRoll={(patternId) => {
                timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId } }))
              }}
              onRename={handlePatternRename}
            />

            {/* Left: track headers (Edit view) or the property tree (Motion view,
                which also portals its key area into motionKeyHost below). */}
            {isMotionView ? (
              <MotionView
                ref={motionViewRef}
                tracks={visibleTracks}
                allTracks={tracks}
                data={motionData.data}
                refresh={motionData.refresh}
                adopt={motionData.adopt}
                keyHost={motionKeyHost}
                width={motionHeaderWidth}
                ppbRef={pixelsPerBeatRef}
                scrollOffsetRef={scrollOffsetRef}
                snapGranularity={snapGranularity}
                focusedTrackId={focusedTrackId}
                onFocusTrack={setFocusedTrackId}
                onPearl={handlePearl}
                onViewportWheel={handleWheel}
                onSeekTick={(tick) => handleSeek(ticksToBeats(tick))}
                reveal={motionReveal}
                pinnedHeader={(
                  <SnapshotCueLaneHeader
                    onAddCue={snapshotCues.addCueAtPlayhead}
                    disabled={!snapshotCues.activeSnapshotId}
                  />
                )}
              />
            ) : (
            <TrackHeaderList
              tracks={tracks}
              folderLayout={normalizedFolderLayout}
              selectedTrackIds={selectedTrackIds}
              onSelectTrack={handleSelectTrack}
              onClearSelection={() => setSelectedTrackIds(new Set())}
              onMoveTracks={handleMoveFolderTracks}
              onMoveFolder={handleMoveFolder}
              onToggleFolder={handleToggleFolder}
              onRenameFolder={handleRenameFolder}
              onRemoveFolder={handleRemoveFolder}
              editingFolderId={editingFolderId}
              onFinishFolderEdit={(folderId) => setEditingFolderId(folderId ?? null)}
              focusedTrackId={focusedTrackId}
              onFocusTrack={setFocusedTrackId}
              onOpenInMixer={handleOpenTrackInMixer}
              onAddTrack={handleAddTrackClick}
              onMute={handleMute}
              onSolo={handleSolo}
              onPearl={handlePearl}
              onVisualOnly={handleVisualOnly}
              onRename={handleRename}
              onRemove={handleRemove}
              onRequestContextMenu={handleRequestTrackContextMenu}
              onSetTrackColor={handleSetTrackColor}
              scrollContainerRef={scrollContainerRef}
              width={timelineTrackHeaderWidth}
              trackHeight={trackHeight}
              macroRows={trackLayout.macroRows}
              reelRows={trackLayout.reelRows}
              cloneRows={trackLayout.cloneRows}
              motionTrackIds={motionTrackIds}
              onToggleReelLane={handleToggleReelLane}
              onHideMacroLane={(trackId, macroNodeId) =>
                useEffectChainStore.getState().hideMacroAutomationLaneForTrack?.(trackId, macroNodeId)}
              automationGroupRows={trackLayout.automationGroupRows}
              automationLaneRows={trackLayout.automationLaneRows}
              onToggleAutomationGroup={handleToggleAutomationGroup}
              onDeleteAutomationLane={handleDeleteAutomationLane}
              onAddClipTrack={() => handleAddTrack('Clip')}
              onAddPatternTrack={() => handleAddTrack('Pattern')}
              pinnedHeader={(
                <SnapshotCueLaneHeader
                  onAddCue={snapshotCues.addCueAtPlayhead}
                  disabled={!snapshotCues.activeSnapshotId}
                />
              )}
            />
            )}

            {/* Resize handle — 4px drag zone between header column and canvas */}
            <div
              className="timeline-header-resize-handle"
              onMouseDown={handleHeaderResizeStart}
            />

            {/* Right: canvas area */}
            <div className="timeline-canvas-area" ref={canvasAreaRef}>
              <TimelineRuler
                ref={rulerRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                scrollOffsetRef={scrollOffsetRef}
                playheadBeatRef={playheadBeatRef}
                onSeek={handleSeek}
                snapGranularity={snapGranularity}
                onWheel={handleWheel}
              />
              {/* Vegas-style loop/render region overlay — sits over the ruler.
                  Repositions on zoom/scroll off the same refs the ruler canvas
                  draws with, pushed per frame by commitViewportRedraw. */}
              <div className={`loop-region-overlay ${loopRegionOverlayClassName}`} style={{ height: RULER_HEIGHT }}>
                <LoopRegionBar
                  ref={loopRegionBarRef}
                  pixelsPerBeatRef={pixelsPerBeatRef}
                  scrollOffsetRef={scrollOffsetRef}
                  snapGranularity={snapGranularity}
                  rulerHeight={RULER_HEIGHT}
                />
              </div>
              <SnapshotCueLane
                ref={cueLaneRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                scrollOffsetRef={scrollOffsetRef}
                cues={snapshotCues.cues}
                snapshots={snapshotCues.snapshots}
                defaultSnapshotId={snapshotCues.defaultSnapshotId}
                totalBeats={totalBeats}
                snapGranularity={snapGranularity}
                onMoveCue={snapshotCues.moveCue}
                onRemoveCue={snapshotCues.removeCue}
                onRepointCue={snapshotCues.repointCue}
                onSetCueTransition={snapshotCues.setCueTransition}
                tracks={tracks}
                onSetCueLandings={snapshotCues.setCueLandings}
                onReflowCueLandings={snapshotCues.reflowCueLandings}
              />
              {isMotionView ? (
                <div className={motionKeyHostClassName} ref={setMotionKeyHost} data-testid="motion-key-host" />
              ) : (
              <div
                className="timeline-canvas-scroll"
                ref={scrollContainerRef}
                onScroll={(e) => {
                  // The Edit view's own scroll, kept per view (R19).
                  saveEditScroll(e.currentTarget.scrollTop)
                  // Sync vertical scroll to track headers
                  const headerScroll = document.querySelector('.timeline-header-scroll')
                  if (headerScroll && headerScroll.scrollTop !== e.currentTarget.scrollTop) {
                    headerScroll.scrollTop = e.currentTarget.scrollTop
                  }
                  // Catch-all: whatever moved scrollTop (wheel-driven spring,
                  // the middle-mouse-pan direct write, row-height zoom's
                  // reposition, or a native scrollbar drag), keep the
                  // scrollY spring's bookkeeping honest so the next
                  // wheel-driven animation eases from the real position.
                  viewAnimatorRef.current?.setCurrent('scrollY', e.currentTarget.scrollTop)
                }}
              >
                <TimelineCanvas
                  ref={canvasRef}
                  trackCount={visibleTracks.length}
                  pixelsPerBeatRef={pixelsPerBeatRef}
                  scrollOffsetRef={scrollOffsetRef}
                  playheadBeatRef={playheadBeatRef}
                  onWheel={handleWheel}
                  clips={clips}
                  regions={regions}
                  tracks={visibleTracks}
                  selectedClipIds={selectedClipIds}
                  dropPreviewRef={dropPreviewRef}
                  waveformCacheRef={waveformCacheRef}
                  hiResCacheRef={hiResCacheRef}
                  clipPeakCacheRef={clipPeakCacheRef}
                  bpmRef={bpmRef}
                  activeTool={activeTool}
                  stickyNoteLength={stickyNoteLength}
                  setStickyNoteLength={adoptStickyNoteLength}
                  activeSampleId={activeSampleId}
                  snapGranularity={snapGranularity}
                  onCreateClip={handleCreateClip}
                  onDeleteClip={handleDeleteClip}
                  onMoveClips={handleMoveClips}
                  onDuplicateClips={handleDuplicateClips}
                  onResizeClip={handleResizeClip}
                  onResizeClipLeft={handleResizeClipLeft}
                  onStretchClip={handleStretchClip}
                  onStretchClipLeft={handleStretchClipLeft}
                  onSplitClip={handleSplitClip}
                  onSetClipVelocity={handleSetClipVelocity}
                  onSetClipFade={handleSetClipFade}
                  onBeginClipControlEdit={handleBeginClipControlEdit}
                  onPreviewClipControlEdit={handlePreviewClipControlEdit}
                  onCommitClipControlEdit={handleCommitClipControlEdit}
                  onCancelClipControlEdit={handleCancelClipControlEdit}
                  clipControlSpec={clipControlSpec}
                  onMiddleMousePan={handleMiddleMousePan}
                  onRequestClipContextMenu={(clipId, x, y) => {
                    setQuickFxMenu(null)
                    setContextMenu({ type: 'clip', clipId, x, y })
                  }}
                  onRequestPatternBlockContextMenu={(block, x, y) => {
                    setQuickFxMenu(null)
                    setContextMenu({ type: 'patternBlock', blockId: block.id, x, y })
                  }}
                  automationClips={automationClips}
                  automationEnvelopesById={automationEnvelopesById}
                  automationBindingLabelsById={automationBindingLabelsById}
                  selectedAutomationClipIds={selectedAutomationClipIds}
                  setSelectedAutomationClipIds={setSelectedAutomationClipIds}
                  onMoveAutomationClip={handleMoveAutomationClip}
                  onResizeAutomationClip={handleResizeAutomationClip}
                  onResizeAutomationClipLeft={handleResizeAutomationClipLeft}
                  onDuplicateAutomationClips={handleDuplicateAutomationClips}
                  onRequestAutomationClipContextMenu={(clip, x, y) => {
                    setQuickFxMenu(null)
                    setContextMenu({ type: 'automationClip', clipId: clip.id, x, y })
                  }}
                  selectedAutomationPoint={selectedAutomationPoint}
                  setSelectedAutomationPoint={setSelectedAutomationPoint}
                  onAddAutomationPoint={handleAddAutomationPoint}
                  onRemoveAutomationPoint={handleRemoveAutomationPoint}
                  onMoveAutomationPoint={handleMoveAutomationPoint}
                  onOpenClipFxQuickMenu={(clipId, anchor) => {
                    setContextMenu(null)
                    setQuickFxMenu({ clipId, x: anchor.x, y: anchor.y })
                  }}
                  scrollOffset={scrollOffset}
                  pixelsPerBeat={pixelsPerBeat}
                  trackLayout={trackLayout}
                  reel={reelModel}
                  setSelectedClipIds={setSelectedClipIds}
                  onFocusTrack={setFocusedTrackId}
                  pencilTemplateRef={pencilTemplateRef}
                  onSetPencilTemplate={updatePencilTemplate}
                  onCanvasDragOver={handleCanvasDragOver}
                  onCanvasDrop={handleCanvasDrop}
                  onCanvasDragLeave={handleCanvasDragLeave}
                  patternBlocks={patternBlocks}
                  patterns={patterns}
                  selectedBlockIds={selectedBlockIds}
                  setSelectedBlockIds={setSelectedBlockIds}
                  currentPatternIdByTrack={currentPatternIdByTrack}
                  onCreatePatternBlock={handleCreatePatternBlock}
                  onMovePatternBlocks={handleMovePatternBlocks}
                  onDuplicatePatternBlocks={handleDuplicatePatternBlocks}
                  onResizePatternBlock={handleResizePatternBlock}
                  onResizePatternBlockLeft={handleResizePatternBlockLeft}
                  onDeletePatternBlock={handleDeletePatternBlock}
                  onSplitPatternBlock={handleSplitPatternBlock}
                  onOpenPianoRoll={(patternId, blockId) => {
                    timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId, blockId } }))
                  }}
                  timelineDisplaySettings={timelineDisplaySettings}
                />
                <MacroAutomationLanes
                  trackLayout={trackLayout}
                  graphStates={graphStates}
                  pixelsPerBeat={pixelsPerBeat}
                  scrollOffset={scrollOffset}
                  snapGranularity={snapGranularity}
                />
                {/* Matches the header column's trailing "Add Track" row +
                    drop zone (6px) — without this the two panels' scrollable
                    content heights diverge and drift out of sync while
                    scrolling to the bottom. */}
                <div className="timeline-canvas-footer-spacer" style={{ height: ADD_TRACK_ROW_HEIGHT + 6 }} />
              </div>
              )}
              <TimelineScrollbar
                ref={scrollbarRef}
                scrollOffsetRef={scrollOffsetRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                maxScrollRef={maxScrollRef}
                totalBeats={totalBeats}
                canvasWidth={canvasWidth}
                onScroll={(delta) => {
                  // Wheel-over-scrollbar — same discrete-notch treatment as
                  // the main canvas's shift+wheel branch. Release a
                  // still-easing zoom's anchor first (see that branch).
                  // Auto Scroll owns horizontal position while following.
                  if (isFollowLocked()) return
                  zoomAnchorRef.current = null
                  const animator = viewAnimatorRef.current
                  const nextScroll = Math.max(0, Math.min(maxScrollRef.current, animator.getTarget('scrollX') + delta))
                  animator.setTarget('scrollX', nextScroll)
                }}
                onScrollTo={(beat) => {
                  // Thumb drag + click-to-page — direct 1:1, not eased (a
                  // dragged thumb must track the cursor exactly); sync the
                  // spring so the next wheel gesture doesn't jump. Also
                  // releases a still-easing zoom's anchor (see above).
                  // Auto Scroll owns horizontal position while following.
                  if (isFollowLocked()) return
                  zoomAnchorRef.current = null
                  const clamped = scrollTo(beat)
                  viewAnimatorRef.current?.setCurrent('scrollX', clamped)
                }}
                scrollOffset={scrollOffset}
                pixelsPerBeat={pixelsPerBeat}
              />
            </div>
        </>
        {CLIP_CONTROL_TUNER_ENABLED && ClipControlTuner && (
          clipControlTunerOpen ? (
            <Suspense fallback={null}>
              <ClipControlTuner
                spec={clipControlSpec}
                onSpecChange={setClipControlSpec}
                onClose={() => setClipControlTunerOpen(false)}
                pixelsPerBeat={pixelsPerBeat}
              />
            </Suspense>
          ) : (
            <button
              type="button"
              className="clip-control-tuner-launcher"
              onClick={() => setClipControlTunerOpen(true)}
            >
              Clip control lab
            </button>
          )
        )}
      </div>

      {/* ── Context menu ─────────────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeClipContextMenu}
        />
      )}

      {/* ── Phase G.4: Quick FX menu (anchored to on-clip FX badge) ─────── */}
      {quickFxMenu && (() => {
        const clip = clipsRef.current.find(c => c.id === quickFxMenu.clipId)
        if (!clip) return null
        const mod = clip?.modulation ?? {}
        const v = mod.vibrato ?? {}
        const s = mod.scratch ?? {}
        const vfx = mod.video ?? {}
        const reversed = !!clip?.reversed
        const formant = !!clip?.formantPreserve
        const vibratoOn = !!(mod.enabled && v.enabled)
        const scratchOn = !!(mod.enabled && s.enabled)
        const swirlSaved = !!vfx.vibratoSwirlEnabled
        const waveSaved  = !!vfx.scratchWaveEnabled
        const presetKey = scratchPresetKeyForScratch(s)
        const showBabyScratchControls = scratchOn && presetKey === 'babyScratch'
        const babySettings = inferBabyScratchSettings(s) ?? {
          count: SCRATCH_BABY_DEFAULT_COUNT,
          lengthBeats: SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
        }
        const updateBabyScratch = (patch) => {
          handleSetClipScratch(clip.id, {}, {
            presetKey: 'babyScratch',
            scratchCount: patch.count ?? babySettings.count,
            lengthBeats: patch.lengthBeats ?? babySettings.lengthBeats,
          })
        }
        const stopFocusQ = (e) => { e.preventDefault(); e.stopPropagation() }
        const sectionLabel = {
          padding: '4px 8px 0', fontSize: 10, color: '#aaa',
          fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase',
        }
        const tinyHint = {
          padding: '0 8px 4px', fontSize: 10,
          color: 'var(--theme-text-tertiary, #888)',
        }
        const content = (
          <div style={{ minWidth: 230, maxWidth: 260 }}>
            <div
              onMouseDown={stopFocusQ}
              style={{
                padding: '4px 8px', fontSize: 11, color: '#aaa',
                fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                borderBottom: '1px solid var(--theme-border-subtle, #333)',
              }}
            >Quick FX</div>

            {(reversed || formant) && (
              <div style={{ padding: '4px 8px 2px' }}>
                {reversed && (
                  <div style={{ fontSize: 11, color: 'var(--theme-semantic-warning-text)' }}>
                    Bypassed: Reverse
                  </div>
                )}
                {formant && (
                  <div style={{ fontSize: 11, color: 'var(--theme-semantic-warning-text)' }}>
                    Bypassed: Formant
                  </div>
                )}
              </div>
            )}

            {vibratoOn && (
              <>
                <div style={sectionLabel}>Vibrato</div>
                <ClipSliderRow
                  label="Vib Depth"
                  value={Math.round(v.depthCents ?? 0)}
                  min={0} max={1200} step={1}
                  onCommit={(val) => handleSetClipVibrato(clip.id, { depthCents: val })}
                  formatValue={(val) => `${val} ¢`}
                />
                {v.rateMode === 'tempoSync' ? (
                  <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ fontSize: 11, color: '#aaa', minWidth: 60 }}>Vib Sync</span>
                    <XlethSelect
                      className="clip-mod-select"
                      value={v.syncDivision ?? 'eighth'}
                      options={VIBRATO_SYNC_DIVISIONS.map(([val, lbl]) => ({ value: val, label: lbl }))}
                      onChange={(val) => handleSetClipVibrato(clip.id, { syncDivision: val })}
                    />
                  </div>
                ) : (
                  <ClipSliderRow
                    label="Vib Rate"
                    value={Number((v.rateHz ?? 5).toFixed(2))}
                    min={0.1} max={20} step={0.1}
                    onCommit={(val) => handleSetClipVibrato(clip.id, { rateHz: val })}
                    formatValue={(val) => `${val.toFixed(2)} Hz`}
                  />
                )}
              </>
            )}

            {scratchOn && (
              <>
                <div style={sectionLabel}>Scratch</div>
                <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ fontSize: 11, color: '#aaa', minWidth: 60 }}>Preset</span>
                  <XlethSelect
                    className="clip-mod-select"
                    value={presetKey}
                    options={[
                      { value: 'custom', label: 'Custom', disabled: true },
                      ...SCRATCH_PRESETS.map(p => ({ value: p.key, label: p.label })),
                    ]}
                    onChange={(val) => handleSetClipScratch(clip.id, {}, { presetKey: val })}
                  />
                </div>
                <ClipSliderRow
                  label="Scratch Smooth"
                  value={Number((s.smoothingMs ?? SCRATCH_DEFAULTS.smoothingMs).toFixed(1))}
                  min={0} max={50} step={0.1}
                  onCommit={(val) => handleSetClipScratch(clip.id, { smoothingMs: val })}
                  formatValue={(val) => `${Number(val).toFixed(1)} ms`}
                />
                {showBabyScratchControls && (
                  <>
                    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ fontSize: 11, color: '#aaa', minWidth: 78 }}>Scratch Count</span>
                      <Fader
                        orientation="horizontal" fill thickness={14}
                        value={babySettings.count} min={1} max={8} defaultValue={SCRATCH_BABY_DEFAULT_COUNT}
                        fromNorm={quantizedFromNorm(1, 8, 1)}
                        onLiveChange={(v) => updateBabyScratch({ count: clampScratchCount(v) })}
                      />
                      <input
                        type="number" min={1} max={8} step={1}
                        value={babySettings.count}
                        onChange={(e) => updateBabyScratch({ count: clampScratchCount(e.target.value) })}
                        style={{ width: 44 }}
                      />
                    </div>
                    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ fontSize: 11, color: '#aaa', minWidth: 78 }}>Length</span>
                      <XlethSelect
                        className="clip-mod-select"
                        value={babySettings.lengthBeats}
                        options={SCRATCH_BABY_LENGTHS.map(([length, label]) => ({ value: length, label }))}
                        onChange={(val) => updateBabyScratch({ lengthBeats: val })}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {swirlSaved && (
              <>
                <div style={sectionLabel}>Video Swirl</div>
                <ClipSliderRow
                  label="Swirl"
                  value={Number((vfx.swirlAmount ?? 0.25).toFixed(2))}
                  min={-1} max={1} step={0.01}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { swirlAmount: val })}
                  formatValue={(val) => Number(val).toFixed(2)}
                />
                {!vibratoOn && (
                  <div style={tinyHint}>Waiting for Vibrato</div>
                )}
              </>
            )}

            {waveSaved && (
              <>
                <div style={sectionLabel}>Video Wave</div>
                <ClipSliderRow
                  label="Wave"
                  value={Number((vfx.waveAmount ?? 0.08).toFixed(2))}
                  min={-1} max={1} step={0.01}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { waveAmount: val })}
                  formatValue={(val) => Number(val).toFixed(2)}
                />
                <ClipSliderRow
                  label="Freq"
                  value={Number((vfx.waveFrequency ?? 8).toFixed(2))}
                  min={0.25} max={64} step={0.25}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { waveFrequency: val })}
                  formatValue={(val) => `${Number(val).toFixed(2)}×`}
                />
                <ClipSliderRow
                  label="Smear"
                  value={Number((vfx.smearAmount ?? 0).toFixed(2))}
                  min={-1} max={1} step={0.01}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { smearAmount: val })}
                  formatValue={(val) => Number(val).toFixed(2)}
                />
                {!scratchOn && (
                  <div style={tinyHint}>Waiting for Scratch</div>
                )}
              </>
            )}
          </div>
        )
        return (
          <ContextMenu
            x={quickFxMenu.x}
            y={quickFxMenu.y}
            items={[{ type: 'custom', key: 'quick-fx', content }]}
            onClose={() => setQuickFxMenu(null)}
          />
        )
      })()}

      {/* ── Track context menu (pattern/clip track actions) ──────────────── */}
      {trackMenu && (
        <TrackContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          items={buildTrackMenuItems(trackMenu.track)}
          onClose={() => setTrackMenu(null)}
        />
      )}

      {/* ── "+" add-track type picker (Clip vs Pattern) ───────────────────── */}
      {addTrackMenu && (
        <TrackContextMenu
          x={addTrackMenu.x}
          y={addTrackMenu.y}
          items={[
            { label: 'Clip Track', onClick: () => handleAddTrack('Clip') },
            { label: 'Pattern Track', onClick: () => handleAddTrack('Pattern') },
          ]}
          onClose={() => setAddTrackMenu(null)}
        />
      )}

      {/* ── Confirmation dialog ──────────────────────────────────────────── */}
      {confirmDialog && (
        <ConfirmConvertDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={confirmDialog.onCancel}
        />
      )}

      {/* ── Quantize dialog ──────────────────────────────────────────────── */}
      <QuantizeDialog
        isOpen={quantizeOpen}
        onClose={() => setQuantizeOpen(false)}
        onApply={handleQuantizeApply}
        snapGranularity={snapGranularity}
        selectionCount={selectedClipIds.size + selectedBlockIds.size}
        hasPatternBlock={selectedBlockIds.size > 0}
        hasClip={selectedClipIds.size > 0}
      />
    </div>
  )
}
