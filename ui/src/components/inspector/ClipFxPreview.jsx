import { useEffect, useRef, useState } from 'react'
import styles from './ClipFxPreview.module.css'

// ── Static visual FX preview (Phase G.3) ─────────────────────────────────────
// Compact two-pane Original / Effect Preview rendered with Canvas 2D. Uses a
// representative max-intensity snapshot of the Swirl/Wave/Smear shader math so
// users can see what their settings will do before hitting play or render.
const CLIP_FX_PREVIEW_W = 128
const CLIP_FX_PREVIEW_H = 72
const CLIP_FX_TAU = 6.28318530717958647692
const CLIP_FX_VIBRATO_LFO = 1.0
const CLIP_FX_SCRATCH_INTENSITY = 1.0
// Mid-cycle phase keeps wave peaks visible across the full preview height.
const CLIP_FX_SCRATCH_PHASE_01 = 0.25
const CLIP_FX_SCRATCH_RATE_MULT = 1.0

function clipFxClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// Bilinear sample with clamp-to-edge from a flat RGBA Uint8ClampedArray.
function clipFxSample(src, w, h, u, v, out) {
  const fx = clipFxClamp(u, 0, 1) * (w - 1)
  const fy = clipFxClamp(v, 0, 1) * (h - 1)
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1)
  const tx = fx - x0, ty = fy - y0
  const i00 = (y0 * w + x0) * 4
  const i10 = (y0 * w + x1) * 4
  const i01 = (y1 * w + x0) * 4
  const i11 = (y1 * w + x1) * 4
  for (let c = 0; c < 4; c++) {
    const a = src[i00 + c] * (1 - tx) + src[i10 + c] * tx
    const b = src[i01 + c] * (1 - tx) + src[i11 + c] * tx
    out[c] = a * (1 - ty) + b * ty
  }
}

export default function ClipFxPreview({ thumbDataUrl, vfx, swirlOn, waveOn, disabledReason }) {
  const origCanvasRef = useRef(null)
  const fxCanvasRef = useRef(null)
  const srcImageDataRef = useRef(null) // ImageData for the loaded thumbnail
  const [loadFailed, setLoadFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const rafRef = useRef(0)

  // Reset failure state when thumbnail dataURL changes.
  useEffect(() => {
    setLoadFailed(false)
    setLoaded(false)
    srcImageDataRef.current = null
  }, [thumbDataUrl])

  // Load thumbnail into an offscreen canvas at preview resolution.
  useEffect(() => {
    if (!thumbDataUrl) return
    let cancelled = false
    const img = new window.Image()
    img.onload = () => {
      if (cancelled) return
      const off = document.createElement('canvas')
      off.width = CLIP_FX_PREVIEW_W
      off.height = CLIP_FX_PREVIEW_H
      const offCtx = off.getContext('2d')
      offCtx.drawImage(img, 0, 0, CLIP_FX_PREVIEW_W, CLIP_FX_PREVIEW_H)
      try {
        srcImageDataRef.current = offCtx.getImageData(
          0, 0, CLIP_FX_PREVIEW_W, CLIP_FX_PREVIEW_H,
        )
        setLoaded(true)
      } catch (e) {
        console.warn('[ClipFxPreview] getImageData failed', e)
        setLoadFailed(true)
      }
    }
    img.onerror = () => { if (!cancelled) setLoadFailed(true) }
    img.src = thumbDataUrl
    return () => { cancelled = true }
  }, [thumbDataUrl])

  // Schedule a single rAF redraw whenever inputs change.
  useEffect(() => {
    if (!loaded) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const src = srcImageDataRef.current
      if (!src) return
      const W = CLIP_FX_PREVIEW_W, H = CLIP_FX_PREVIEW_H

      // Original pane: blit unchanged.
      const origCtx = origCanvasRef.current?.getContext('2d')
      if (origCtx) origCtx.putImageData(src, 0, 0)

      // Effect pane: per-pixel CPU remap matching FX_VibratoSwirl /
      // FX_ScratchWaveSmear (sample-and-blend smear).
      const fxCtx = fxCanvasRef.current?.getContext('2d')
      if (!fxCtx) return
      const dst = fxCtx.createImageData(W, H)
      const dstData = dst.data
      const srcData = src.data

      const swirlAmt    = swirlOn ? Number(vfx.swirlAmount    ?? 0.25) : 0
      const swirlRadius = Math.max(Number(vfx.swirlRadius     ?? 0.45), 0.0001)
      const cx          = Number(vfx.swirlCenterX ?? 0.5)
      const cy          = Number(vfx.swirlCenterY ?? 0.5)
      const waveAmt     = waveOn ? Number(vfx.waveAmount      ?? 0.08) : 0
      const waveFreq    = Number(vfx.waveFrequency  ?? 8.0)
      const smearAmt    = waveOn ? Number(vfx.smearAmount     ?? 0.0) : 0
      const reverseW    = !!(vfx.reverseWaveWithScratch ?? true)

      const direction = (reverseW && CLIP_FX_SCRATCH_RATE_MULT < 0) ? -1 : 1
      const phase = CLIP_FX_SCRATCH_PHASE_01 * CLIP_FX_TAU
      const safeFreq = clipFxClamp(waveFreq, 0.25, 64.0)
      const smearOffset = clipFxClamp(
        smearAmt * 0.25 * direction * CLIP_FX_SCRATCH_INTENSITY,
        -0.25, 0.25,
      )
      const smearBlend = clipFxClamp(Math.abs(smearAmt), 0, 1) * CLIP_FX_SCRATCH_INTENSITY

      const baseTap = [0, 0, 0, 0]
      const lTap = [0, 0, 0, 0]
      const rTap = [0, 0, 0, 0]

      for (let py = 0; py < H; py++) {
        const v = py / (H - 1)
        for (let px = 0; px < W; px++) {
          const u = px / (W - 1)
          let uu = u, vv = v

          // ── Swirl ─────────────────────────────────────────────────────
          if (swirlOn) {
            const dx = uu - cx, dy = vv - cy
            const r = Math.sqrt(dx * dx + dy * dy)
            let f = 1 - r / swirlRadius
            if (f < 0) f = 0
            else if (f > 1) f = 1
            const falloff = f * f * (3 - 2 * f)
            let angle = swirlAmt * 3.0 * CLIP_FX_VIBRATO_LFO * falloff
            if (angle < -1.25) angle = -1.25
            else if (angle > 1.25) angle = 1.25
            const ca = Math.cos(angle), sa = Math.sin(angle)
            uu = cx + dx * ca - dy * sa
            vv = cy + dx * sa + dy * ca
          }

          // ── Wave + Smear (sample-and-blend) ───────────────────────────
          if (waveOn) {
            const wave = Math.sin(vv * safeFreq * CLIP_FX_TAU + phase)
            let waveOffset = wave * waveAmt * 1.5 * CLIP_FX_SCRATCH_INTENSITY * direction
            if (waveOffset < -0.35) waveOffset = -0.35
            else if (waveOffset > 0.35) waveOffset = 0.35
            const wuvX = uu + waveOffset
            clipFxSample(srcData, W, H, wuvX, vv, baseTap)
            if (smearBlend > 0 && smearOffset !== 0) {
              clipFxSample(srcData, W, H, wuvX - smearOffset, vv, lTap)
              clipFxSample(srcData, W, H, wuvX + smearOffset, vv, rTap)
              const inv = 1 - smearBlend
              const di = (py * W + px) * 4
              dstData[di    ] = baseTap[0] * inv + ((lTap[0] + rTap[0]) * 0.5) * smearBlend
              dstData[di + 1] = baseTap[1] * inv + ((lTap[1] + rTap[1]) * 0.5) * smearBlend
              dstData[di + 2] = baseTap[2] * inv + ((lTap[2] + rTap[2]) * 0.5) * smearBlend
              dstData[di + 3] = baseTap[3] * inv + ((lTap[3] + rTap[3]) * 0.5) * smearBlend
            } else {
              const di = (py * W + px) * 4
              dstData[di    ] = baseTap[0]
              dstData[di + 1] = baseTap[1]
              dstData[di + 2] = baseTap[2]
              dstData[di + 3] = baseTap[3]
            }
          } else {
            // Swirl-only path: sample once at remapped UV.
            clipFxSample(srcData, W, H, uu, vv, baseTap)
            const di = (py * W + px) * 4
            dstData[di    ] = baseTap[0]
            dstData[di + 1] = baseTap[1]
            dstData[di + 2] = baseTap[2]
            dstData[di + 3] = baseTap[3]
          }
        }
      }

      fxCtx.putImageData(dst, 0, 0)
    })
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [
    loaded, swirlOn, waveOn,
    vfx.swirlAmount, vfx.swirlRadius, vfx.swirlCenterX, vfx.swirlCenterY,
    vfx.waveAmount, vfx.waveFrequency, vfx.smearAmount, vfx.reverseWaveWithScratch,
  ])

  if (!swirlOn && !waveOn) return null

  if (disabledReason) {
    return <p className={styles.note}>{disabledReason}</p>
  }
  if (loadFailed || (!thumbDataUrl)) {
    return <p className={styles.note}>Preview unavailable for this clip.</p>
  }

  return (
    <div className={styles.panes}>
      <figure className={styles.pane}>
        <figcaption className={styles.label}>Original</figcaption>
        <canvas ref={origCanvasRef} width={CLIP_FX_PREVIEW_W} height={CLIP_FX_PREVIEW_H} className={styles.canvas} />
      </figure>
      <figure className={styles.pane}>
        <figcaption className={styles.label}>Effect preview</figcaption>
        <canvas ref={fxCanvasRef} width={CLIP_FX_PREVIEW_W} height={CLIP_FX_PREVIEW_H} className={styles.canvas} />
      </figure>
    </div>
  )
}
