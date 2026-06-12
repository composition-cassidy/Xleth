import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

function clamp(value, min, max) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

export function getXlethSelectSelectedOption(options, value) {
  return options.find(option => Object.is(option.value, value))
    || options.find(option => String(option.value) === String(value))
    || null
}

function getScrollParents(node) {
  if (!node || typeof window === 'undefined') return []
  const parents = []
  let parent = node.parentElement
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent)
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`
    if (/(auto|scroll|overlay)/.test(overflow)) parents.push(parent)
    parent = parent.parentElement
  }
  parents.push(window)
  return parents
}

export default function XlethSelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder = 'Select...',
  className = '',
}) {
  const generatedId = useId()
  const triggerId = id || `xleth-select-${generatedId}`
  const listboxId = `${triggerId}-listbox`
  const triggerRef = useRef(null)
  const popupRef = useRef(null)
  const optionRefs = useRef([])
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [position, setPosition] = useState(null)

  const selectedOption = useMemo(
    () => getXlethSelectSelectedOption(options, value),
    [options, value]
  )

  const selectedIndex = useMemo(() => {
    const index = options.findIndex(option => option === selectedOption)
    return index >= 0 ? index : 0
  }, [options, selectedOption])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || typeof window === 'undefined') {
      setOpen(false)
      return
    }

    const rect = trigger.getBoundingClientRect()
    const viewportPadding = 8
    const minWidth = Math.max(rect.width, 180)
    const width = Math.min(minWidth, window.innerWidth - viewportPadding * 2)
    const left = clamp(rect.left, viewportPadding, window.innerWidth - width - viewportPadding)
    const below = window.innerHeight - rect.bottom - viewportPadding
    const above = rect.top - viewportPadding
    const opensUp = below < 180 && above > below
    const available = Math.max(120, opensUp ? above : below)
    const maxHeight = Math.min(280, available)

    setPosition(opensUp
      ? {
          left,
          width,
          maxHeight,
          bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 4),
          placement: 'top',
        }
      : {
          left,
          width,
          maxHeight,
          top: Math.min(window.innerHeight - viewportPadding, rect.bottom + 4),
          placement: 'bottom',
        })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setPosition(null)
  }, [])

  const openPopup = useCallback((index = selectedIndex) => {
    if (disabled || options.length === 0) return
    setHighlightedIndex(clamp(index, 0, options.length - 1))
    setOpen(true)
  }, [disabled, options.length, selectedIndex])

  useEffect(() => {
    if (!open) return
    updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event) => {
      const trigger = triggerRef.current
      const popup = popupRef.current
      if (trigger?.contains(event.target) || popup?.contains(event.target)) return
      close()
    }

    const handleViewportChange = () => updatePosition()
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    const scrollParents = getScrollParents(triggerRef.current)
    window.addEventListener('resize', handleViewportChange)
    scrollParents.forEach(parent => parent.addEventListener('scroll', handleViewportChange, true))
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('resize', handleViewportChange)
      scrollParents.forEach(parent => parent.removeEventListener('scroll', handleViewportChange, true))
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [close, open, updatePosition])

  useEffect(() => {
    if (!open) return
    optionRefs.current[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedIndex, open])

  useEffect(() => {
    if (disabled) close()
  }, [close, disabled])

  const selectIndex = useCallback((index) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange?.(option.value)
    close()
    triggerRef.current?.focus()
  }, [close, onChange, options])

  const moveHighlight = useCallback((direction) => {
    if (options.length === 0) return
    setHighlightedIndex(current => {
      let next = current
      for (let i = 0; i < options.length; i += 1) {
        next = (next + direction + options.length) % options.length
        if (!options[next]?.disabled) return next
      }
      return current
    })
  }, [options])

  const handleTriggerKeyDown = (event) => {
    if (disabled) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) openPopup(selectedIndex)
        else moveHighlight(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (!open) openPopup(selectedIndex)
        else moveHighlight(-1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (!open) openPopup(selectedIndex)
        else selectIndex(highlightedIndex)
        break
      case 'Tab':
        close()
        break
      default:
        break
    }
  }

  const popup = open && position && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={popupRef}
          className={`xleth-select-popup xleth-select-popup--${position.placement}`}
          style={{
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            top: position.top,
            bottom: position.bottom,
          }}
          role="listbox"
          id={listboxId}
          aria-labelledby={triggerId}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
        >
          {options.map((option, index) => {
            const selected = option === selectedOption
              || Object.is(option.value, value)
              || String(option.value) === String(value)
            const highlighted = index === highlightedIndex
            return (
              <button
                key={`${String(option.value)}-${option.label}`}
                ref={(node) => { optionRefs.current[index] = node }}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                data-value={String(option.value)}
                className={`xleth-select-option${selected ? ' xleth-select-option--selected' : ''}${highlighted ? ' xleth-select-option--highlighted' : ''}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectIndex(index)}
              >
                <span className="xleth-select-option-label">{option.label}</span>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            )
          })}
        </div>,
        document.body
      )
    : null

  return (
    <>
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        className={`xleth-select-trigger ${className}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          if (open) close()
          else openPopup(selectedIndex)
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="xleth-select-trigger-label">
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown
          className="xleth-select-chevron"
          size={15}
          aria-hidden="true"
        />
      </button>
      {popup}
    </>
  )
}
