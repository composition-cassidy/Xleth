import React from 'react'
import { useEffect, useRef, useState } from 'react'

const POLL_MS = 500

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function formatUs(value) {
  const us = numberOrZero(value)
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`
  return `${us.toFixed(0)} us`
}

function formatSamples(value) {
  return `${Math.round(numberOrZero(value))} smp`
}

function scopeLabel(scope) {
  if (!scope) return 'None'
  const kind = scope.kind || 'scope'
  const effect = scope.effectTypeName && scope.effectTypeName !== 'unknown'
    ? ` ${scope.effectTypeName}`
    : ''
  const track = numberOrZero(scope.trackId) >= 0 ? ` T${scope.trackId}` : ''
  const node = numberOrZero(scope.slotOrNodeId) >= 0 ? ` N${scope.slotOrNodeId}` : ''
  return `${kind}${effect}${track}${node}: p99 ${formatUs(scope.p99Us)}, max ${formatUs(scope.maxUs)}`
}

function listLabel(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(', ') : 'None'
}

function rsHqTone(level) {
  if (level === 'overrunning') return 'bad'
  if (level === 'warning') return 'warn'
  return 'ok'
}

function coverageTone(level) {
  if (level === 'good') return 'ok'
  if (level === 'usable') return 'warn'
  if (level === 'poor' || level === 'inconclusive') return 'bad'
  return 'warn'
}

export function RsHqRiskDiagnostics({ data }) {
  const rs = data?.resonanceSuppressorHighQuality || {}
  const level = data?.realtimeRsHqRiskLevel || rs.riskLevel || 'healthy'
  const activeCount = numberOrZero(
    data?.activeResonanceSuppressorHighQualityInstanceCount ?? rs.activeInstanceCount
  )
  const reasons = data?.realtimeRsHqRiskReasons || rs.riskReasons || []
  const actions = data?.recommendedAction || rs.recommendedAction || []
  const isRisk = level === 'warning' || level === 'overrunning'

  return (
    <section className="audio-perf-diag-group">
      <div className="audio-perf-diag-title">RS HQ Realtime Risk</div>
      <div className={`audio-perf-diag-status audio-perf-diag-status--${rsHqTone(level)}`}>
        {level === 'overrunning' ? 'Overrunning' : level === 'warning' ? 'Warning' : 'Healthy'}
      </div>
      <div className="audio-perf-diag-kv">
        <span>Active HQ</span><strong>{activeCount}</strong>
        <span>Reasons</span><strong>{listLabel(reasons)}</strong>
        <span>Action</span><strong>{listLabel(actions)}</strong>
      </div>
      {isRisk && (
        <div className="audio-perf-diag-note">
          RS HQ is expensive in realtime. Use a larger buffer, reduce HQ instances, or reserve HQ for export.
        </div>
      )}
    </section>
  )
}

function classifyHealth(snapshot, previous) {
  const deadline = numberOrZero(snapshot?.callbackDeadlineUs)
  const p99 = numberOrZero(snapshot?.callbackP99Us)
  const max = numberOrZero(snapshot?.callbackMaxUs)
  const overruns = numberOrZero(snapshot?.callbackOverrunCount)
    + numberOrZero(snapshot?.mixEngineOverrunCount)
  const previousOverruns = numberOrZero(previous?.callbackOverrunCount)
    + numberOrZero(previous?.mixEngineOverrunCount)
  const dropped = numberOrZero(snapshot?.droppedTelemetrySamples)
  const previousDropped = numberOrZero(previous?.droppedTelemetrySamples)

  if (deadline > 0 && (p99 >= deadline || max >= deadline || overruns > previousOverruns)) {
    return { label: 'Overrunning', tone: 'bad' }
  }
  if (deadline > 0 && p99 >= deadline * 0.6) {
    return { label: 'Warning', tone: 'warn' }
  }
  if (dropped > previousDropped) {
    return { label: 'Warning', tone: 'warn' }
  }
  return { label: 'Healthy', tone: 'ok' }
}

export default function AudioPerformanceDiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState(null)
  const [health, setHealth] = useState({ label: 'Healthy', tone: 'ok' })
  const [error, setError] = useState('')
  const [captureSeconds, setCaptureSeconds] = useState(10)
  const [captureState, setCaptureState] = useState({
    status: 'idle',
    message: '',
    path: '',
    coverageQuality: '',
  })
  const previousRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let timer = null

    async function poll() {
      try {
        const next = await window.xleth?.audio?.getAudioPerformanceTelemetry?.()
        if (!cancelled && next) {
          setSnapshot(next)
          setHealth(classifyHealth(next, previousRef.current))
          previousRef.current = next
          setError('')
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e))
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS)
      }
    }

    window.xleth?.audio?.setRealtimeDiagnosticsEnabled?.(true).catch(() => {})
    poll()
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [])

  const data = snapshot || {}
  const worstEffectMax = data.worstEffectsByMax?.[0]
  const worstEffectP99 = data.worstEffectsByP99?.[0]
  const worstChainMax = data.worstChainsByMax?.[0]
  const rs = data.resonanceSuppressorHighQuality || {}

  async function captureReport() {
    if (!window.xleth?.audio?.captureAudioPerformanceReport) {
      setCaptureState({
        status: 'failed',
        message: 'Capture export unavailable in this build.',
        path: '',
        coverageQuality: '',
      })
      return
    }

    setCaptureState({
      status: 'capturing',
      message: `Capturing ${captureSeconds}s performance report...`,
      path: '',
      coverageQuality: '',
    })
    try {
      const result = await window.xleth.audio.captureAudioPerformanceReport({
        seconds: captureSeconds,
        includeJson: true,
        includeMarkdown: true,
        label: 'settings-audio-diagnostics',
      })
      const outputPath = result?.markdownPath || result?.jsonPath || ''
      setCaptureState({
        status: 'exported',
        message: 'Performance report exported.',
        path: outputPath,
        coverageQuality: result?.report?.telemetryCoverageQuality || '',
      })
    } catch (e) {
      setCaptureState({
        status: 'failed',
        message: String(e?.message || e),
        path: '',
        coverageQuality: '',
      })
    }
  }

  return (
    <div className="audio-perf-diag">
      <section className="audio-perf-diag-capture">
        <div className="audio-perf-diag-capture-controls">
          <label className="settings-panel-label" htmlFor="audio-perf-capture-seconds">
            Performance report
          </label>
          <select
            id="audio-perf-capture-seconds"
            className="settings-panel-select"
            value={captureSeconds}
            onChange={e => setCaptureSeconds(Number(e.target.value))}
            disabled={captureState.status === 'capturing'}
          >
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
          </select>
          <button
            type="button"
            className="settings-panel-button"
            onClick={captureReport}
            disabled={captureState.status === 'capturing'}
          >
            {captureState.status === 'capturing'
              ? `Capturing ${captureSeconds}s...`
              : `Capture ${captureSeconds}s Performance Report`}
          </button>
        </div>
        <div
          className={`audio-perf-diag-capture-status audio-perf-diag-capture-status--${captureState.status}`}
        >
          {captureState.status === 'idle' && 'Idle'}
          {captureState.status === 'capturing' && captureState.message}
          {captureState.status === 'exported' && (
            <>
              {captureState.message}
              {captureState.coverageQuality && (
                <strong className={`audio-perf-diag-status audio-perf-diag-status--${coverageTone(captureState.coverageQuality)}`}>
                  Coverage {captureState.coverageQuality}
                </strong>
              )}
              <span>{captureState.path}</span>
            </>
          )}
          {captureState.status === 'failed' && `Failed: ${captureState.message}`}
        </div>
      </section>
      <div className="audio-perf-diag-grid">
        <section className="audio-perf-diag-group">
          <div className="audio-perf-diag-title">Latency / PDC</div>
          <div className="audio-perf-diag-kv">
            <span>Max track</span><strong>{formatSamples(data.maxAudibleTrackLatencySamples)}</strong>
            <span>Master</span><strong>{formatSamples(data.masterInsertLatencySamples)}</strong>
            <span>Device out</span><strong>{formatSamples(data.audioDeviceOutputLatencySamples)}</strong>
            <span>Total presentation</span><strong>{formatSamples(data.livePresentationLatencySamples)}</strong>
          </div>
        </section>

        <section className="audio-perf-diag-group">
          <div className="audio-perf-diag-title">Realtime CPU</div>
          <div className={`audio-perf-diag-status audio-perf-diag-status--${health.tone}`}>
            {health.label}
          </div>
          <div className="audio-perf-diag-kv">
            <span>Deadline</span><strong>{formatUs(data.callbackDeadlineUs)}</strong>
            <span>Callback p95</span><strong>{formatUs(data.callbackP95Us)}</strong>
            <span>Callback p99</span><strong>{formatUs(data.callbackP99Us)}</strong>
            <span>Callback max</span><strong>{formatUs(data.callbackMaxUs)}</strong>
            <span>Overruns</span><strong>{numberOrZero(data.callbackOverrunCount) + numberOrZero(data.mixEngineOverrunCount)}</strong>
            <span>Dropped samples</span><strong>{numberOrZero(data.droppedTelemetrySamples)}</strong>
            <span>Lock misses</span><strong>{numberOrZero(data.lockMissCount)}</strong>
            <span>Stale reuse</span><strong>{numberOrZero(data.staleSnapshotReuseCount)}</strong>
          </div>
        </section>

        <RsHqRiskDiagnostics data={data} />

        <section className="audio-perf-diag-group audio-perf-diag-group--wide">
          <div className="audio-perf-diag-title">Worst Effects</div>
          <div className="audio-perf-diag-lines">
            <div><span>Effect max</span><strong>{scopeLabel(worstEffectMax)}</strong></div>
            <div><span>Effect p99</span><strong>{scopeLabel(worstEffectP99)}</strong></div>
            <div><span>Chain max</span><strong>{scopeLabel(worstChainMax)}</strong></div>
            <div>
              <span>Resonance Suppressor HQ</span>
              <strong>
                {numberOrZero(rs.wolaCallCount) > 0
                  ? `WOLA max ${formatUs(rs.maxWolaUs)}, calls ${numberOrZero(rs.wolaCallCount)}`
                  : 'No WOLA timing yet'}
              </strong>
            </div>
          </div>
        </section>
      </div>
      {error && <div className="settings-panel-hint" style={{ color: '#e08a3a' }}>Audio telemetry unavailable: {error}</div>}
    </div>
  )
}
