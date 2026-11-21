import { useEffect, useMemo, useState } from 'react'
import { resolveTimelinePalette } from '../timeline/timelineDrawing.js'
import { resolveAutoTrackColor, TRACK_PALETTE_FALLBACK } from '../timeline/trackColorResolver.js'

/**
 * { [trackId]: '#RRGGBB' } — each track's identity colour, resolved exactly the
 * way the arrangement's track headers resolve it (index in project track order,
 * see TrackHeaderList). One colour, four places: lane, header, grid cell, layer
 * list. Recomputes after a theme switch. The palette is read in render, never at
 * module scope (tokenValue() is empty before ThemeProvider mounts).
 */
export default function useTrackIdentityColors(tracks) {
  const [themeRev, setThemeRev] = useState(0)
  useEffect(() => {
    const bump = () => setThemeRev((n) => n + 1)
    window.addEventListener('xleth-theme-changed', bump)
    document.addEventListener('xleth-theme-changed', bump)
    return () => {
      window.removeEventListener('xleth-theme-changed', bump)
      document.removeEventListener('xleth-theme-changed', bump)
    }
  }, [])

  return useMemo(() => {
    const map = {}
    if (!Array.isArray(tracks) || tracks.length === 0) return map
    const palette = resolveTimelinePalette().trackPalette
    tracks.forEach((track, index) => {
      map[track.id] = resolveAutoTrackColor(track, index, palette, TRACK_PALETTE_FALLBACK[index % 16])
    })
    return map
    // themeRev forces a recompute after a theme switch.
  }, [tracks, themeRev])
}
