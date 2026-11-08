import { useEffect, useRef, useState } from 'react'

// The content-box size of an element, kept current with a ResizeObserver. The
// modulation canvases take width/height props; their host reports its size here
// and the canvas sits absolutely inside it, so it can never push the box it measures.
export function useBoxSize(fallback = { width: 460, height: 140 }) {
  const ref = useRef(null)
  const [size, setSize] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const update = (w, h) => {
      const width = Math.max(40, Math.round(w))
      const height = Math.max(40, Math.round(h))
      setSize((cur) => (cur.width === width && cur.height === height ? cur : { width, height }))
    }
    update(el.clientWidth || fallback.width, el.clientHeight || fallback.height)
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) update(r.width, r.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}
