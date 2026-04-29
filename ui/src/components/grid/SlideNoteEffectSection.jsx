export default function SlideNoteEffectSection({ track, fetchTracks }) {
  const type         = track.slideNoteEffect?.type ?? 0
  const durationMode = track.slideNoteEffect?.durationMode ?? 0
  const fixedMs      = track.slideNoteEffect?.fixedDurationMs ?? 300

  const set = async (patch) => {
    await window.xleth?.timeline?.setTrackSlideNoteEffect(track.id,
      { ...(track.slideNoteEffect ?? {}), ...patch })
    fetchTracks()
  }

  return (
    <div className="grid-tab-track-slide">
      <div className="grid-tab-slide-header">SLIDE NOTE EFFECT</div>
      <select
        className="grid-tab-slide-type-select"
        value={type}
        onChange={e => set({ type: parseInt(e.target.value) || 0 })}
      >
        <option value="0">None</option>
        <option value="1">Zoom/Pan/Rot</option>
        <option value="2">Bounce</option>
        <option value="3">TV Simulator</option>
      </select>
      {type !== 0 && (
        <div className="grid-tab-slide-params">
          <label>Duration</label>
          <select
            value={durationMode}
            onChange={e => set({ durationMode: parseInt(e.target.value) || 0 })}
          >
            <option value="0">Follow Slide</option>
            <option value="1">Fixed</option>
          </select>
          <span />
          {durationMode === 1 && (
            <>
              <label>Fixed ms</label>
              <input
                type="number" min={10} max={5000} step={10}
                defaultValue={fixedMs}
                onBlur={async (e) => {
                  const v = parseFloat(e.target.value) || 300
                  set({ fixedDurationMs: v })
                }}
              />
              <span className="grid-tab-slide-readout">{fixedMs}ms</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
