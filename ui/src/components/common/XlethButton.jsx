import React, { forwardRef } from 'react'

export const XlethButton = forwardRef(function XlethButton({
  active = false,
  className = '',
  type = 'button',
  children,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`xleth-button ${className}`.trim()}
      data-active={active ? 'true' : 'false'}
      {...props}
    >
      {children}
    </button>
  )
})

export const XlethIconButton = forwardRef(function XlethIconButton({
  active = false,
  className = '',
  type = 'button',
  children,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`xleth-icon-button ${className}`.trim()}
      data-active={active ? 'true' : 'false'}
      {...props}
    >
      {children}
    </button>
  )
})

export default XlethButton
