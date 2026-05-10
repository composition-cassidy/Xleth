import { describe, expect, it } from 'vitest'
import { shouldShowRsHqRealtimeWarning } from '../ResonanceSuppressorPanel.jsx'

describe('ResonanceSuppressorPanel RS HQ guardrail', () => {
  it('shows the inline HQ warning only for warning or overrunning diagnostics', () => {
    expect(shouldShowRsHqRealtimeWarning({ realtimeRsHqRiskLevel: 'healthy' })).toBe(false)
    expect(shouldShowRsHqRealtimeWarning({ realtimeRsHqRiskLevel: 'warning' })).toBe(true)
    expect(shouldShowRsHqRealtimeWarning({
      resonanceSuppressorHighQuality: { riskLevel: 'overrunning' },
    })).toBe(true)
  })
})
