import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AudioPerformanceDiagnosticsPanel, { RsHqRiskDiagnostics } from './AudioPerformanceDiagnosticsPanel.jsx'

describe('AudioPerformanceDiagnosticsPanel RS HQ risk', () => {
  it('renders the bridge risk fields compactly', () => {
    const html = renderToStaticMarkup(
      <RsHqRiskDiagnostics
        data={{
          activeResonanceSuppressorHighQualityInstanceCount: 2,
          realtimeRsHqRiskLevel: 'warning',
          realtimeRsHqRiskReasons: ['multipleInstances'],
          recommendedAction: ['reduceHqInstances', 'useHqForExport'],
        }}
      />
    )

    expect(html).toContain('RS HQ Realtime Risk')
    expect(html).toContain('Active HQ')
    expect(html).toContain('2')
    expect(html).toContain('multipleInstances')
    expect(html).toContain('reduceHqInstances, useHqForExport')
    expect(html).toContain('RS HQ is expensive in realtime')
  })
})

describe('AudioPerformanceDiagnosticsPanel capture control', () => {
  it('renders the real-project capture button and idle status', () => {
    const html = renderToStaticMarkup(<AudioPerformanceDiagnosticsPanel />)

    expect(html).toContain('Performance report')
    expect(html).toContain('Capture 10s Performance Report')
    expect(html).toContain('Idle')
  })
})
