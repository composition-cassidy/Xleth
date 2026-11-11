// UI kit gallery (dev only). Mounted by main.jsx at `?view=ui-kit` when the
// bundle was built with VITE_XLETH_UI_KIT_GALLERY=1; the normal build never
// contains it.
//
// Every component is shown in every state: rest, hover, active, focus, disabled,
// bipolar, clipped meter and long-label overflow. Hover / active / focus are
// FORCED with `data-state` so they can be captured without a mouse.
//
// Query flags:   ?zoom=1.5   scales the page like the Electron window zoom
//                ?shots=1    freezes the meter signal (deterministic captures)
//
// Meters in the gallery are fed a SYNTHETIC test signal. It exists only here, is
// labelled as such, and is never part of a real view.

import { useEffect, useMemo, useState } from 'react'
import { Mic, Play, Scissors, Settings, Square, X } from 'lucide-react'
import {
  Button, Dialog, DialogList, DialogListItem, DialogText, EmptyState, Fader, FaderMeter, IconButton, Knob, Menu, MenuItem,
  MenuSeparator, Meter, NumberBox, PanelHeader, SectionHeader,
  SegmentedControl, Select, Tabs, Toggle, Toolbar, ToolbarSeparator, syncCodec, Icon, GLYPH_NAMES,
} from './index'
import styles from './Gallery.module.css'
import EffectDevice from '../components/devices/EffectDevice.jsx'
import useDeviceUiStore from '../components/devices/deviceUiStore.js'
import useCompressorStore from '../stores/compressorStore.js'
import MixerGalleryFixture from '../components/mixer/MixerGalleryFixture.jsx'
import BrowserGalleryFixture from '../components/browser/BrowserGalleryFixture.jsx'
import PickerGalleryFixture from '../components/SamplePicker/PickerGalleryFixture.jsx'

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const FROZEN = params.get('shots') === '1'
const ZOOM = Number(params.get('zoom')) || 1

const STATES = ['rest', 'hover', 'active', 'focus']
const LONG = 'A label that is much too long for its cell'
const SYNC = syncCodec(['1/16', '1/16D', '1/8T', '1/8', '1/8D', '1/4', '1/4D', '1/2', '1/1'])

/** A labelled specimen. */
function Spec({ caption, children, wide }) {
  return (
    <figure className={styles.spec} data-wide={wide || undefined}>
      <div className={styles.specBody}>{children}</div>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  )
}

function Section({ title, children }) {
  return (
    <section className={styles.section}>
      <SectionHeader>{title}</SectionHeader>
      <div className={styles.row}>{children}</div>
    </section>
  )
}

// The Compressor device in every state (Phase 4a). No engine here: values are
// the manifest defaults and the displays are idle (no fabricated signal). Each
// specimen is its own node id so fold / pop-out state does not leak across.
const GALLERY_TRACK = '9'
const compressorFx = (nodeId, extra = {}) => ({
  nodeId, pluginId: 'compressor', position: 0, bypassed: false,
  effectInstanceId: `gallery-${nodeId}`, sidechain: { supported: true, channels: 2, enabled: false }, ...extra,
})
// Phase 4b devices, three specimens each (active, bypassed, folded). Node ids
// are base, base + 1, base + 2 so no state leaks between them.
const PHASE_4B_DEVICES = [
  { pluginId: 'delay', title: 'Delay', base: 11 },
  { pluginId: 'flanger', title: 'Flanger', base: 21 },
  { pluginId: 'uniflange', title: 'UniFlange', base: 31 },
  { pluginId: 'reverb', title: 'Reverb', base: 41 },
  { pluginId: 'limiter', title: 'Limiter', base: 51 },
  { pluginId: 'xletheq', title: 'Parametric EQ', base: 61 },
]
const deviceFx = (pluginId, nodeId, extra = {}) => ({
  nodeId, pluginId, position: 0, bypassed: false, effectInstanceId: `gallery-${nodeId}`, ...extra,
})
function useGalleryDeviceStates() {
  useState(() => {
    useDeviceUiStore.getState().setFolded(`${GALLERY_TRACK}:3`, true)
    for (const d of PHASE_4B_DEVICES) useDeviceUiStore.getState().setFolded(`${GALLERY_TRACK}:${d.base + 2}`, true)
    useCompressorStore.setState({ target: { trackId: 9, nodeId: 4, storeKey: GALLERY_TRACK } })
    return null
  })
}

const stateProp = (s) => (s === 'rest' ? {} : { 'data-state': s })

// A synthetic signal: a slow two-channel sweep (live) or fixed levels (shots).
function useSyntheticFeed(base = -18, clipAtStart = false) {
  return useMemo(() => (push) => {
    if (FROZEN) {
      push([base, base - 3])
      if (clipAtStart) push([0, base])
      return () => {}
    }
    let t = 0
    if (clipAtStart) push([0, base])
    const id = setInterval(() => {
      t += 0.06
      push([base + 10 * Math.sin(t), base + 8 * Math.sin(t * 1.3 + 1)])
    }, 33)
    return () => clearInterval(id)
  }, [base, clipAtStart])
}

/** Opens the real Menu and Dialog on demand (they are portaled, fixed-position surfaces). */
function OverlayDemos() {
  const [menu, setMenu] = useState(null)
  const [dialog, setDialog] = useState(null)
  const close = () => { setMenu(null); setDialog(null) }
  return (
    <>
      <Spec caption="menu: rows 24px, arrows / Home / End, Esc closes">
        <Button
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }) }}
        >
          Open menu
        </Button>
      </Spec>
      <Spec caption="dialog: 16px prose, list, actions">
        <div className={styles.inline}>
          <Button onClick={() => setDialog('confirm')}>Open confirm</Button>
          <Button onClick={() => setDialog('list')}>Open list</Button>
        </div>
      </Spec>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={close} label="Clip menu">
          <MenuItem checked>Snap to grid</MenuItem>
          <MenuItem checked={false}>Ripple edit</MenuItem>
          <MenuSeparator />
          <MenuItem>Duplicate</MenuItem>
          <MenuItem disabled>Paste</MenuItem>
          <MenuItem danger>Delete</MenuItem>
        </Menu>
      )}
      {dialog === 'confirm' && (
        <Dialog
          title="Unsaved changes"
          width="sm"
          onClose={close}
          actions={<><Button size="lg" onClick={close}>Cancel</Button><Button size="lg" variant="danger" onClick={close}>Discard</Button><Button size="lg" variant="primary" onClick={close} data-autofocus>Save</Button></>}
        >
          <DialogText>You have unsaved changes. Save them before starting a new project?</DialogText>
        </Dialog>
      )}
      {dialog === 'list' && (
        <Dialog
          title="Clean up project"
          onClose={close}
          actions={<><Button size="lg" onClick={close}>Cancel</Button><Button size="lg" variant="primary" onClick={close} data-autofocus>Clean up 2.5 GB</Button></>}
        >
          <DialogText>Delete leftover and unused preview files to free disk space. Your source media is never touched.</DialogText>
          <DialogList label="Files to delete">
            <DialogListItem label="Video proxies" value="2 files · 2.0 GB" />
            <DialogListItem label="Unfinished files from interrupted jobs" value="3 files · 0.5 GB" />
            <DialogListItem strong label="Will free" value="5 files · 2.5 GB" />
          </DialogList>
        </Dialog>
      )}
    </>
  )
}

export default function Gallery() {
  const [knob, setKnob] = useState(-20)
  const [pan, setPan] = useState(0.35)
  const [time, setTime] = useState(3)
  const [mix, setMix] = useState(70)
  const [level, setLevel] = useState(-6)
  const [mute, setMute] = useState(true)
  const [seg, setSeg] = useState('b')
  const [tab, setTab] = useState('mixer')
  const [sel, setSel] = useState('auto')

  useEffect(() => {
    document.documentElement.style.zoom = String(ZOOM)
    return () => { document.documentElement.style.zoom = '' }
  }, [])

  useGalleryDeviceStates()
  const feed = useSyntheticFeed(-18)
  const clippedFeed = useSyntheticFeed(-24, true)
  const quietFeed = useSyntheticFeed(-48)

  const selectOptions = [
    { value: 'auto', label: 'Auto (recommended)' },
    { value: 'sw', label: 'Software' },
    { value: 'hw', label: 'Hardware' },
    { value: 'long', label: 'A very long option label that has to truncate in the trigger' },
  ]

  return (
    <div className={styles.page} data-testid="ui-kit-gallery">
      <PanelHeader title="UI kit gallery" meta={`dev only · zoom ${Math.round(ZOOM * 100)}% · meters show a synthetic test signal`} />

      <Section title="Knob: rest, hover, active, focus">
        {STATES.map((s) => (
          <Spec key={s} caption={s}>
            <Knob label="Threshold" value={knob} min={-60} max={0} unit="dB" defaultValue={-20} onChange={setKnob} {...stateProp(s)} />
          </Spec>
        ))}
        <Spec caption="disabled"><Knob label="Threshold" value={-20} min={-60} max={0} unit="dB" disabled /></Spec>
        <Spec caption="bipolar (pan)"><Knob label="Pan" value={pan} min={-1} max={1} bipolar format={(v) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`)} defaultValue={0} onChange={setPan} /></Spec>
        <Spec caption="bipolar, negative"><Knob label="Trim" value={-9} min={-18} max={18} unit="dB" bipolar formatOptions={{ signed: true }} /></Spec>
        <Spec caption="bipolar at centre"><Knob label="Detune" value={0} min={-100} max={100} unit="%" bipolar /></Spec>
        <Spec caption="at minimum"><Knob label="Attack" value={0.1} min={0.1} max={100} unit="ms" /></Spec>
        <Spec caption="at maximum"><Knob label="Mix" value={100} min={0} max={100} unit="%" /></Spec>
        <Spec caption="tempo-synced"><Knob label="Time" value={time} codec={SYNC} onChange={setTime} /></Spec>
        <Spec caption="small (24px dial)"><Knob label="Q" value={0.7} min={0.1} max={10} size={24} format={(v) => v.toFixed(2)} /></Spec>
        <Spec caption="long label"><Knob label={LONG} value={4} min={1} max={20} unit="ratio" /></Spec>
        <Spec caption="infinite ratio"><Knob label="Ratio" value={Infinity} min={1} max={100} unit="ratio" /></Spec>
      </Section>

      <Section title="NumberBox: rest, hover, active, focus">
        {STATES.map((s) => (
          <Spec key={s} caption={s}>
            <NumberBox label="Mix" value={mix} min={0} max={100} unit="%" defaultValue={100} onChange={setMix} {...stateProp(s)} />
          </Spec>
        ))}
        <Spec caption="disabled"><NumberBox label="Mix" value={70} min={0} max={100} unit="%" disabled /></Spec>
        <Spec caption="bipolar"><NumberBox label="Width" value={-40} min={-100} max={100} unit="%" bipolar /></Spec>
        <Spec caption="no visible label"><NumberBox label="Tempo" hideLabel value={140} min={20} max={300} format={(v) => `${Math.round(v)} BPM`} width={88} /></Spec>
        <Spec caption="long label, narrow"><NumberBox label={LONG} value={12.5} min={0} max={100} unit="ms" width={96} /></Spec>
        <Spec caption="frequency"><NumberBox label="Freq" value={5490} min={20} max={20000} unit="Hz" width={104} /></Spec>
      </Section>

      <Section title="Fader + meter">
        <Spec caption="live"><div className={styles.tall}><FaderMeter label="Track 1" value={level} onChange={setLevel} subscribe={feed} /></div></Spec>
        <Spec caption="clipped (latched until clicked)"><div className={styles.tall}><FaderMeter label="Track 2" value={0} subscribe={clippedFeed} /></div></Spec>
        <Spec caption="quiet, mono"><div className={styles.tall}><FaderMeter label="Track 3" value={-18} channels={1} subscribe={quietFeed} /></div></Spec>
        <Spec caption="floor (-inf)"><div className={styles.tall}><FaderMeter label="Track 4" value={-Infinity} subscribe={quietFeed} /></div></Spec>
        <Spec caption="fader: rest / hover / active / focus">
          <div className={styles.faders}>
            {STATES.map((s) => (<div key={s} className={styles.faderCol}><Fader label={`Level ${s}`} value={-6} {...stateProp(s)} /></div>))}
            <div className={styles.faderCol}><Fader label="Level disabled" value={-6} disabled /></div>
          </div>
        </Spec>
        <Spec caption="meter only, scale hidden"><div className={styles.tall}><Meter label="Bus" subscribe={feed} channels={2} showScale={false} /></div></Spec>
      </Section>

      <Section title="Toggle, Button, IconButton">
        <Spec caption="toggle off / on / glyph"><div className={styles.inline}>
          <Toggle on={false}>Mute</Toggle>
          <Toggle on={mute} onChange={setMute} glyph="M">Mute</Toggle>
          <Toggle on={true} glyph="S" aria-label="Solo" />
        </div></Spec>
        <Spec caption="toggle hover / active / focus / disabled"><div className={styles.inline}>
          <Toggle on={false} data-state="hover">Hover</Toggle>
          <Toggle on={false} data-state="active">Active</Toggle>
          <Toggle on={false} data-state="focus">Focus</Toggle>
          <Toggle on={false} disabled>Disabled</Toggle>
        </div></Spec>
        <Spec caption="button rest / hover / active / focus / disabled"><div className={styles.inline}>
          <Button>Rest</Button>
          <Button data-state="hover">Hover</Button>
          <Button data-state="active">Active</Button>
          <Button data-state="focus">Focus</Button>
          <Button disabled>Disabled</Button>
        </div></Spec>
        <Spec caption="sizes 24 / 28 / 32, ghost"><div className={styles.inline}>
          <Button size="sm">Small</Button>
          <Button>Medium</Button>
          <Button size="lg">Large</Button>
          <Button variant="ghost">Ghost</Button>
        </div></Spec>
        <Spec caption="icon buttons: rest / hover / on / focus / disabled"><div className={styles.inline}>
          <IconButton label="Play"><Play /></IconButton>
          <IconButton label="Stop" data-state="hover"><Square /></IconButton>
          <IconButton label="Record" pressed><Mic /></IconButton>
          <IconButton label="Region shown (quiet on)" pressed tone="quiet"><Settings /></IconButton>
          <IconButton label="Settings" data-state="focus"><Settings /></IconButton>
          <IconButton label="Close" disabled><X /></IconButton>
        </div></Spec>
        <Spec caption="long label"><Button>{LONG}</Button></Spec>
        <Spec caption="dialog variants: primary (the one default action) / danger / default, size 32"><div className={styles.inline}>
          <Button size="lg">Cancel</Button>
          <Button size="lg" variant="danger">Discard</Button>
          <Button size="lg" variant="primary">Save</Button>
        </div></Spec>
      </Section>

      <Section title="Menu and Dialog (floating surfaces: hard offset shadow)">
        <OverlayDemos />
      </Section>

      <Section title="SegmentedControl, Select, Tabs, Toolbar">
        <Spec caption="segmented"><SegmentedControl label="Spacebar mode" value={seg} onChange={setSeg} options={[{ value: 'a', label: 'Play / stop' }, { value: 'b', label: 'Play / pause' }, { value: 'c', label: 'Hold', disabled: true }]} /></Spec>
        <Spec caption="segmented, disabled"><SegmentedControl label="Mode" value="a" disabled options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }]} /></Spec>
        <Spec caption="select rest"><Select ariaLabel="Decode" value={sel} options={selectOptions} onChange={setSel} /></Spec>
        <Spec caption="select hover"><Select ariaLabel="Decode" value="sw" options={selectOptions} data-state="hover" /></Spec>
        <Spec caption="select focus"><Select ariaLabel="Decode" value="sw" options={selectOptions} data-state="focus" /></Spec>
        <Spec caption="select disabled"><Select ariaLabel="Decode" value="sw" options={selectOptions} disabled /></Spec>
        <Spec caption="select long value (truncates)"><Select ariaLabel="Decode" value="long" options={selectOptions} /></Spec>
        <Spec caption="tabs" wide><Tabs label="Detail dock" value={tab} onChange={setTab} tabs={[{ id: 'devices', label: 'Devices' }, { id: 'mixer', label: 'Mixer' }, { id: 'roll', label: 'Piano roll' }, { id: 'sampler', label: 'Sampler', disabled: true }]} /></Spec>
        <Spec caption="toolbar"><Toolbar label="Piano roll tools">
          <IconButton label="Draw" pressed><Play /></IconButton>
          <IconButton label="Slice"><Scissors /></IconButton>
          <ToolbarSeparator />
          <IconButton label="Settings"><Settings /></IconButton>
        </Toolbar></Spec>
      </Section>

      <Section title="PanelHeader, SectionHeader, EmptyState">
        <Spec caption="panel header (28px)" wide><PanelHeader title="Mixer" meta="12 tracks"><IconButton label="Close panel" size="sm"><X /></IconButton></PanelHeader></Spec>
        <Spec caption="panel header, long title" wide><div className={styles.narrow}><PanelHeader title="A panel title that is far too long to fit this width" meta="meta"><IconButton label="Close" size="sm"><X /></IconButton></PanelHeader></div></Spec>
        <Spec caption="section header in a device" wide><div className={styles.narrow}><SectionHeader actions={<Toggle size="sm" on={false}>Sync</Toggle>}>Feedback</SectionHeader></div></Spec>
        <Spec caption="empty state, inside its region" wide><div className={styles.region}><EmptyState message="No tracks. Add a clip track or a pattern track." actionLabel="Add track" onAction={() => {}} /></div></Spec>
        <Spec caption="empty state, no action"><div className={styles.region}><EmptyState message="No presets saved." /></div></Spec>
      </Section>

      <Section title="Device: Compressor (no engine: defaults, idle display)">
        <Spec caption="active, docked (sidechain folded)" wide><EffectDevice effect={compressorFx(1)} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" dragHandleProps={{}} /></Spec>
        <Spec caption="bypassed: activator off, Off, dimmed body" wide><EffectDevice effect={compressorFx(2, { bypassed: true })} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" dragHandleProps={{}} /></Spec>
        <Spec caption="folded"><div className={styles.inline}><EffectDevice effect={compressorFx(3)} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" /><EffectDevice effect={compressorFx(4)} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" /></div></Spec>
        <Spec caption="popped out: the floating window (offset shadow only here)" wide><div className={styles.floatingStage}><EffectDevice effect={compressorFx(4)} storeKey={GALLERY_TRACK} presentation="floating" onClose={() => {}} dragHandleProps={{}} /></div></Spec>
        <Spec caption="not migrated yet: same title bar"><EffectDevice effect={{ nodeId: 5, pluginId: 'chorus', bypassed: false }} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" /></Spec>
      </Section>

      <Section title="Icon set: 16px grid, 1.5px stroke, currentColor">
        <Spec caption="all glyphs at 16 px (the size they ship at), 24 px, and 48 px to check the drawing" wide>
          <div className={styles.iconGrid}>
            {GLYPH_NAMES.map((name) => (
              <figure key={name} className={styles.iconCell}>
                <span className={styles.iconSizes}>
                  <Icon name={name} size={16} />
                  <Icon name={name} size={24} />
                  <Icon name={name} size={48} />
                </span>
                <figcaption className={styles.caption}>{name}</figcaption>
              </figure>
            ))}
          </div>
        </Spec>
      </Section>

      <Section title="Browser: Media and Samples (MOCK data, gallery only)">
        <Spec caption="Media: video, audio-only, a pending proxy, a long name. Rows are 24px; the strip shows the selected source."><BrowserGalleryFixture tab="media" /></Spec>
        <Spec caption="Samples: groups with disclosure triangles, label stripe, selection outline, a swapped-audio mark, root note on Pitch"><BrowserGalleryFixture tab="samples" /></Spec>
      </Section>

      <Section title="Sample picker sheet (MOCK data, gallery only)">
        <Spec caption="At the sheet's default size, 1086 x 340 (a 1366 window less the Browser). No engine: the waveform says so instead of drawing one." wide><PickerGalleryFixture /></Spec>
        <Spec caption="At the floor, 760 x 280 (a narrow window and a short top row): the controls wrap instead of being cut" wide><PickerGalleryFixture width={760} height={280} /></Spec>
      </Section>

      <Section title="Mixer: 16 strips, mixed states (MOCK data, gallery only)">
        <Spec caption="compact width (72 px, the default): selected 5, muted 3, soloed 6, visual-only 8, clipped meter 4, bus 2,3 to 5 and 8 to 10, sidechain 1 to 6, inserts by name (1 with one bypassed, 7 with +3 more, 9 on an FX graph). The dB numerals and the words Pan and Width are printed once, in the gutter. No arm state: the engine has no record-arm." wide><MixerGalleryFixture /></Spec>
        <Spec caption="normal width: the same tracks in 84 px strips" wide><MixerGalleryFixture stripMode="normal" /></Spec>
      </Section>

      {PHASE_4B_DEVICES.map((d) => (
        <Section key={d.pluginId} title={`Device: ${d.title} (no engine: defaults, idle display)`}>
          <Spec caption="active, docked" wide><EffectDevice effect={deviceFx(d.pluginId, d.base)} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" dragHandleProps={{}} /></Spec>
          <Spec caption="bypassed: activator off, Off, dimmed body" wide><EffectDevice effect={deviceFx(d.pluginId, d.base + 1, { bypassed: true })} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" dragHandleProps={{}} /></Spec>
          <Spec caption="folded"><EffectDevice effect={deviceFx(d.pluginId, d.base + 2)} storeKey={GALLERY_TRACK} identityColor="var(--theme-track-palette-2)" /></Spec>
        </Section>
      ))}
    </div>
  )
}
