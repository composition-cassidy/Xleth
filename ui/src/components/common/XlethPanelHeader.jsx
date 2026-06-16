import React from 'react'

export default function XlethPanelHeader({
  title,
  meta,
  className = '',
  children,
}) {
  return (
    <div className={`xleth-panel-header ${className}`.trim()}>
      <span className="xleth-panel-header__title">{title}</span>
      {meta && <span className="xleth-panel-header__meta">{meta}</span>}
      {children}
    </div>
  )
}
