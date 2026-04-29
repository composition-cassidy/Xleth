import { useEffect, useRef } from 'react'
import { resolveTheme, writeThemeToRoot } from '../runtime/applyTheme'
import type { ThemeFile } from '../schema/types'
import SurfacePreview from './previewSurfaces/SurfacePreview'
import TypographyPreview from './previewSurfaces/TypographyPreview'
import AccentPreview from './previewSurfaces/AccentPreview'
import DangerPreview from './previewSurfaces/DangerPreview'
import MixerPreview from './previewSurfaces/MixerPreview'
import TimelinePreview from './previewSurfaces/TimelinePreview'

interface Props {
  workingTheme: ThemeFile
}

export default function PreviewPane({ workingTheme }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const prevValuesRef = useRef<Record<string, string> | undefined>(undefined)

  useEffect(() => {
    if (!rootRef.current) return
    const resolved = resolveTheme(workingTheme)
    writeThemeToRoot(resolved.values, prevValuesRef.current, rootRef.current)
    prevValuesRef.current = resolved.values
  }, [workingTheme])

  return (
    <div className="preview-pane" ref={rootRef}>
      <div className="preview-pane-label">Live Preview</div>
      <SurfacePreview />
      <TypographyPreview />
      <AccentPreview />
      <DangerPreview />
      <MixerPreview />
      <TimelinePreview />
    </div>
  )
}
