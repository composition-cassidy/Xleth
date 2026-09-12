import { useEffect, useRef } from "react"

const DWELL_MS = 200
const GROW_MS = 160
const COLLAPSE_MS = 100
const REST_SCALE = 1
const ICON_PEAK_SCALE = 1.85
const DOCK_FOCUS_SCALE = 1.22
const SEPARATION_FACTOR = 0.5
const PLATE_PAD_Y = 8
const WOBBLE_AMP_PX = 2.2
const WOBBLE_WAVELENGTH_PX = 70
const WOBBLE_SPEED_RAD_PER_MS = 0.004
const PLATE_PAD_X = 10
const PLATE_SHOULDER_PX = 16
const PLATE_SIGMA_SCALE = 1.25
const CLIP_SAMPLES = 64
const CURSOR_SMOOTHING = 0.35
const TOOLTIP_GAP_PX = 10

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function easeOutBack(t) {
  const c1 = 0.9
  const c3 = c1 + 1
  return 1 + c3 * ((t - 1) ** 3) + c1 * ((t - 1) ** 2)
}

function easeOutCubic(t) {
  return 1 - ((1 - t) ** 3)
}

function smoothstep(edge, v) {
  const t = Math.min(Math.max(v / edge, 0), 1)
  return t * t * (3 - 2 * t)
}

export function useDockMagnification(iconSelector) {
  const containerRef = useRef(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let dwellTimer = null
    let raf = null
    let armed = false
    let pointerX = 0
    let smoothedX = 0
    let icons = []
    let avgWidth = 0
    let avgGap = 0
    let restH = 0
    let bulgeMax = 0
    let containerLeft = 0
    let basePlateLeft = 0
    let basePlateW = 0
    let plateLeft = 0
    let plateW = 0

    let amp = 0
    let ampFrom = 0
    let ampTo = 0
    let animStart = 0
    let animDur = 1
    let animEase = easeOutCubic

    const plate = container.querySelector(".titlebar-dock-plate")
    if (!plate) return undefined

    const tooltip = document.createElement("div")
    tooltip.className = "titlebar-dock-tooltip"
    tooltip.setAttribute("aria-hidden", "true")
    document.body.appendChild(tooltip)

    function measure() {
      const rect = container.getBoundingClientRect()
      restH = rect.height
      containerLeft = rect.left
      const sample = container.querySelector(iconSelector)
      const iconW = sample ? sample.getBoundingClientRect().width : 0
      const padX = (iconW * (ICON_PEAK_SCALE - REST_SCALE)) / 2 + PLATE_PAD_X
      bulgeMax = restH * (ICON_PEAK_SCALE - REST_SCALE) + PLATE_PAD_Y + WOBBLE_AMP_PX
      basePlateLeft = rect.left - padX
      basePlateW = rect.width + padX * 2
      plateLeft = basePlateLeft
      plateW = basePlateW
      plate.style.left = (-padX) + "px"
      plate.style.width = plateW + "px"
      plate.style.height = (restH + bulgeMax) + "px"
    }

    function captureIcons() {
      const els = Array.from(container.querySelectorAll(iconSelector))
      icons = els.map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          el,
          center: rect.left + rect.width / 2,
          width: rect.width,
          label: el.dataset.dockLabel || el.getAttribute("aria-label") || el.getAttribute("title") || "",
        }
      })
      avgWidth = icons.length
        ? icons.reduce((sum, icon) => sum + icon.width, 0) / icons.length
        : 0
      avgGap = icons.length > 1
        ? ((icons[icons.length - 1].center - icons[0].center) / (icons.length - 1)) - avgWidth
        : 0
    }

    function iconSigma() {
      if (icons.length < 2) return 40
      const spacing = (icons[icons.length - 1].center - icons[0].center) / (icons.length - 1)
      return Math.max(spacing, 1)
    }

    function gaussianAt(x, sigma) {
      const d = x - smoothedX
      return Math.exp(-(d * d) / (2 * sigma * sigma))
    }

    function growthAt(x, sigma) {
      return (DOCK_FOCUS_SCALE - REST_SCALE)
        + (ICON_PEAK_SCALE - DOCK_FOCUS_SCALE) * gaussianAt(x, sigma)
    }

    function computeLayout(sigma) {
      const n = icons.length
      const scales = icons.map((icon) => REST_SCALE + amp * growthAt(icon.center, sigma))
      if (!n || avgWidth <= 0) {
        return { scales: scales, offsets: [], minEdge: NaN, maxEdge: NaN }
      }

      let cursorX = icons[0].center - avgWidth / 2
      const newCenters = new Array(n)
      let minEdge = Infinity
      let maxEdge = -Infinity
      for (let i = 0; i < n; i += 1) {
        const scale = scales[i]
        const extra = avgWidth * (scale - REST_SCALE) * SEPARATION_FACTOR
        const grownW = avgWidth * scale
        const newLeft = cursorX
        const newCenter = newLeft + avgWidth / 2 + extra / 2
        newCenters[i] = newCenter
        cursorX = newLeft + avgWidth + avgGap + extra
        if (newCenter - grownW / 2 < minEdge) minEdge = newCenter - grownW / 2
        if (newCenter + grownW / 2 > maxEdge) maxEdge = newCenter + grownW / 2
      }

      const restRowCenter = (icons[0].center + icons[n - 1].center) / 2
      const newRowCenter = (newCenters[0] + newCenters[n - 1]) / 2
      const shift = restRowCenter - newRowCenter

      const offsets = icons.map((icon, i) => (newCenters[i] + shift) - icon.center)
      return { scales: scales, offsets: offsets, minEdge: minEdge + shift, maxEdge: maxEdge + shift }
    }

    function restClip() {
      plateLeft = basePlateLeft
      plateW = basePlateW
      plate.style.left = (basePlateLeft - containerLeft) + "px"
      plate.style.width = basePlateW + "px"
      plate.style.clipPath = "polygon(0px 0px, " + plateW + "px 0px, " + plateW + "px " + restH + "px, 0px " + restH + "px)"
    }

    function updatePlateClip(sigma, minEdge, maxEdge) {
      if (amp <= 0.0005) {
        restClip()
        return
      }

      const baseRight = basePlateLeft + basePlateW
      const haveEdges = Number.isFinite(minEdge) && Number.isFinite(maxEdge)
      const desiredLeft = haveEdges ? Math.min(basePlateLeft, minEdge - PLATE_PAD_X) : basePlateLeft
      const desiredRight = haveEdges ? Math.max(baseRight, maxEdge + PLATE_PAD_X) : baseRight
      plateLeft = desiredLeft
      plateW = desiredRight - desiredLeft
      plate.style.left = (plateLeft - containerLeft) + "px"
      plate.style.width = plateW + "px"

      const plateSigma = sigma * PLATE_SIGMA_SCALE
      const phase = performance.now() * WOBBLE_SPEED_RAD_PER_MS
      const points = ["0px 0px", plateW.toFixed(2) + "px 0px"]
      for (let i = CLIP_SAMPLES; i >= 0; i -= 1) {
        const x = (plateW * i) / CLIP_SAMPLES
        const shoulder = smoothstep(PLATE_SHOULDER_PX, x)
          * smoothstep(PLATE_SHOULDER_PX, plateW - x)
        const wobble = WOBBLE_AMP_PX
          * Math.sin(((x / WOBBLE_WAVELENGTH_PX) * Math.PI * 2) + phase)
        const lift = restH * growthAt(plateLeft + x, plateSigma) + PLATE_PAD_Y + wobble
        const bottom = restH + amp * shoulder * lift
        points.push(x.toFixed(2) + "px " + bottom.toFixed(2) + "px")
      }
      plate.style.clipPath = "polygon(" + points.join(", ") + ")"
    }

    function positionTooltip(el, label) {
      const rect = el.getBoundingClientRect()
      tooltip.textContent = label
      tooltip.style.left = (rect.left + rect.width / 2) + "px"
      tooltip.style.top = (rect.bottom + TOOLTIP_GAP_PX) + "px"
      tooltip.dataset.visible = "true"
    }

    function hideTooltip() {
      tooltip.dataset.visible = "false"
    }

    function render() {
      const sigma = iconSigma()
      const layout = computeLayout(sigma)
      const scales = layout.scales
      const offsets = layout.offsets

      let best = null
      icons.forEach((icon, i) => {
        const offsetX = offsets[i] || 0
        icon.el.style.transform = "translateX(" + offsetX.toFixed(2) + "px) scale(" + scales[i].toFixed(4) + ")"
        const falloff = gaussianAt(icon.center, sigma)
        if (!best || falloff > best.falloff) best = { icon: icon, falloff: falloff }
      })

      updatePlateClip(sigma, layout.minEdge, layout.maxEdge)
      if (armed && best) positionTooltip(best.icon.el, best.icon.label)
    }

    function startRamp(to, durationMs, ease) {
      ampFrom = amp
      ampTo = to
      animStart = performance.now()
      animDur = Math.max(durationMs, 1)
      animEase = ease
    }

    function settle() {
      icons.forEach(function (icon) {
        icon.el.style.transform = ""
        icon.el.style.transition = ""
      })
      restClip()
      hideTooltip()
      raf = null
    }

    function tick() {
      const t = Math.min((performance.now() - animStart) / animDur, 1)
      amp = ampFrom + (ampTo - ampFrom) * animEase(t)
      smoothedX += (pointerX - smoothedX) * CURSOR_SMOOTHING

      render()

      const rampDone = t >= 1
      if (!armed && rampDone && amp <= 0.0005) {
        amp = 0
        settle()
        return
      }
      raf = requestAnimationFrame(tick)
    }

    function ensureLoop() {
      if (raf === null) raf = requestAnimationFrame(tick)
    }
    function clearDwell() {
      if (dwellTimer) {
        clearTimeout(dwellTimer)
        dwellTimer = null
      }
    }

    function arm() {
      dwellTimer = null
      if (prefersReducedMotion()) return
      measure()
      captureIcons()
      icons.forEach(function (icon) { icon.el.style.transition = "none" })
      armed = true
      smoothedX = pointerX
      container.dataset.dockArmed = "true"
      plate.style.pointerEvents = "auto"
      startRamp(1, GROW_MS, easeOutBack)
      ensureLoop()
    }

    function collapse() {
      armed = false
      container.dataset.dockArmed = "false"
      plate.style.pointerEvents = "none"
      hideTooltip()
      if (amp <= 0) {
        settle()
        return
      }
      startRamp(0, COLLAPSE_MS, easeOutCubic)
      ensureLoop()
    }

    function handleMouseEnter(e) {
      pointerX = e.clientX
      clearDwell()
      dwellTimer = setTimeout(arm, DWELL_MS)
    }

    function handleMouseMove(e) {
      pointerX = e.clientX
    }

    function handleMouseLeave() {
      clearDwell()
      if (armed || amp > 0) collapse()
    }

    measure()
    restClip()

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(function () {
        measure()
        if (!armed && amp <= 0) restClip()
      })
      : null
    if (resizeObserver) resizeObserver.observe(container)

    container.addEventListener("mouseenter", handleMouseEnter)
    container.addEventListener("mousemove", handleMouseMove)
    container.addEventListener("mouseleave", handleMouseLeave)

    return function () {
      clearDwell()
      if (raf !== null) cancelAnimationFrame(raf)
      if (resizeObserver) resizeObserver.disconnect()
      container.removeEventListener("mouseenter", handleMouseEnter)
      container.removeEventListener("mousemove", handleMouseMove)
      container.removeEventListener("mouseleave", handleMouseLeave)
      icons.forEach(function (icon) {
        icon.el.style.transform = ""
        icon.el.style.transition = ""
      })
      tooltip.remove()
    }
  }, [iconSelector])

  return containerRef
}
