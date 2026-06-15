const DEFAULT_THROTTLE_MS = 16

function defaultRequestFrame(callback) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return { type: 'raf', id: window.requestAnimationFrame(callback) }
  }
  return { type: 'timeout', id: setTimeout(callback, DEFAULT_THROTTLE_MS) }
}

function defaultCancelFrame(handle) {
  if (!handle) return
  if (handle.type === 'raf' && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle.id)
  } else {
    clearTimeout(handle.id)
  }
}

export function createStoppedPreviewSeekScheduler({
  requestPreviewFrame,
  isPlaying,
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
} = {}) {
  if (typeof requestPreviewFrame !== 'function') {
    throw new TypeError('createStoppedPreviewSeekScheduler requires requestPreviewFrame')
  }

  let latestGeneration = 0
  let lastSentGeneration = 0
  let lastSettledGeneration = 0
  let pendingPosition = null
  let scheduledHandle = null
  let disposed = false

  const playing = () => {
    try { return !!isPlaying?.() } catch { return false }
  }

  const clearScheduled = () => {
    if (!scheduledHandle) return
    cancelFrame(scheduledHandle)
    scheduledHandle = null
  }

  const dispatch = () => {
    scheduledHandle = null
    if (disposed || playing()) {
      pendingPosition = null
      return
    }

    const position = pendingPosition
    if (!position) return

    pendingPosition = null
    const generation = latestGeneration
    lastSentGeneration = generation

    Promise.resolve(requestPreviewFrame(position, { generation }))
      .then(() => {
        if (generation === latestGeneration) {
          lastSettledGeneration = generation
        }
      })
      .catch(() => {
        if (generation === latestGeneration) {
          lastSettledGeneration = generation
        }
      })
  }

  const scheduleFrame = () => {
    if (scheduledHandle || disposed) return
    scheduledHandle = requestFrame(dispatch)
  }

  return {
    schedule(position) {
      if (disposed || playing()) {
        pendingPosition = null
        clearScheduled()
        return { scheduled: false, generation: latestGeneration }
      }
      pendingPosition = position
      latestGeneration += 1
      scheduleFrame()
      return { scheduled: true, generation: latestGeneration }
    },

    flush() {
      if (disposed) return
      clearScheduled()
      dispatch()
    },

    dispose() {
      disposed = true
      pendingPosition = null
      clearScheduled()
    },

    getDebugState() {
      return {
        latestGeneration,
        lastSentGeneration,
        lastSettledGeneration,
        hasPendingPosition: !!pendingPosition,
        isScheduled: !!scheduledHandle,
      }
    },
  }
}

export function createXlethStoppedPreviewSeekScheduler({ isPlaying } = {}) {
  return createStoppedPreviewSeekScheduler({
    isPlaying,
    requestPreviewFrame: (position) =>
      window.xleth?.video?.requestPreviewFrameAtTimelinePosition?.(position),
  })
}
