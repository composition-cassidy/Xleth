// What the hint bar says over the viewer overlay, for every hover state
// (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5; ui/DESIGN.md: every control has a hint).
//
// The overlay canvas takes no pointer events, so it writes these onto its parent
// element (data-hint / data-hint-mods) and asks the hint bar to re-read
// ('xleth-hint-refresh'). Pure: the overlay passes what is under the pointer.

import { isShapeAnimated } from '../../motion/maskModel.js'

const ROAM_MODS = 'Drag: move / scale / rotate · Shift: fine move, 15° steps · Esc: cancel'

export const HINT_BLOCKED = 'This parameter is keyed, so it follows its keys. Turn on Auto-key to write a key at the playhead, edit its keys in Motion view, or drag a dot on the path.'

export function roamBaseHint(name, parentName) {
  const home = parentName ? `its grid box as its parent ${parentName} carries it` : 'its grid box'
  return `Roam handles for ${name}: drag the cell to move it, a corner square to scale, the round grip to rotate. The dashed box is ${home}. Dots on the dotted line are position keys: drag one to move it.`
}

const keyedSuffix = (mask) => (isShapeAnimated(mask) ? ' Its shape is keyed: an edit writes a shape key at the playhead.' : '')

const kindWord = (mask) => (mask.kind === 'Ellipse' ? 'ellipse' : mask.kind === 'Rectangle' ? 'rectangle' : 'path')

/**
 * { hint, mods } for the overlay's parent element.
 *   hover       null | 'move' | 'rotate' | 'cornerN' | 'dotN' | a mask hit object
 *               ({ kind: 'maskPoint' | 'maskTangent' | 'maskBox' | 'maskEdge' | 'maskInside'
 *               | 'maskSelect' | 'pen' | 'penClose', index? })
 *   blocked     the hovered Roam handle is refused (keyed, Auto-key off)
 *   trackName, parentName
 *   masks       the track's masks (for names); masksShown: outlines are on the picture
 *   pen         null | { points, cap, blocker }   the pen tool, while it is on
 *   note        a one-off message (a refused edit) that wins over everything else
 *   insertBlocker  why Ctrl+click cannot add a point to the hovered mask, or null
 */
export function overlayHint({
  hover = null, blocked = false, trackName = '', parentName = null, masks = [], masksShown = false,
  pen = null, note = null, insertBlocker = null,
}) {
  if (note) return { hint: note, mods: pen ? 'Esc: cancel the pen' : ROAM_MODS }
  if (pen) {
    if (pen.blocker) return { hint: `${pen.blocker}. Delete a mask or some of its points to draw another.`, mods: 'Esc: put the pen away' }
    const n = pen.points ?? 0
    if (hover?.kind === 'penClose') {
      return { hint: `Click to close the path (${n} points) and add it as a mask.`, mods: 'Click: close · Esc: cancel' }
    }
    if (n >= (pen.cap ?? Infinity)) {
      return {
        hint: `This path has as many points as it can take (${pen.cap}): click the first point or press Enter to close it.`,
        mods: 'Enter: close · Backspace: remove last point · Esc: cancel',
      }
    }
    return {
      hint: `Pen on ${trackName}: click for a corner point, click and drag for a smooth one. Click the first point or press Enter to close the path; Esc cancels.`,
      mods: 'Click: corner · Drag: smooth · Enter: close · Backspace: remove last point · Esc: cancel',
    }
  }
  if (blocked) return { hint: HINT_BLOCKED, mods: ROAM_MODS }
  const mask = hover && typeof hover === 'object' && Number.isInteger(hover.index) ? masks[hover.index] : null
  if (mask) {
    const name = mask.name
    switch (hover.kind) {
      case 'maskPoint':
        return {
          hint: `${name}: drag this point to move it.${mask.kind === 'Path' ? '' : ` Moving one point makes the ${kindWord(mask)} a path.`} Alt+click deletes it (a mask keeps at least 3 points); Alt+drag pulls out its curve handles.${keyedSuffix(mask)}`,
          mods: 'Drag: move point · Shift: fine · Alt+click: delete · Alt+drag: curve handles · Esc: cancel',
        }
      case 'maskTangent':
        return {
          hint: `${name}: drag this handle to bend the edges at its point. The opposite handle follows while the pair is smooth; hold Alt to move this one alone.${keyedSuffix(mask)}`,
          mods: 'Drag: bend · Alt: break the pair · Esc: cancel',
        }
      case 'maskBox':
        return {
          hint: `${name}: drag a corner to resize the ${kindWord(mask)}; the opposite corner stays put. Shift keeps its proportions.${keyedSuffix(mask)}`,
          mods: 'Drag: resize · Shift: keep proportions · Esc: cancel',
        }
      case 'maskEdge':
        return insertBlocker
          ? { hint: `${insertBlocker}: no point can be added to ${name}.`, mods: 'Ctrl+click edge: add point' }
          : {
            hint: `Click to add a point to ${name} here; keep dragging to place it. Every shape key gets the point too.`,
            mods: 'Ctrl+click: add point · Drag: place it · Esc: cancel',
          }
      case 'maskInside':
        return {
          hint: `${name}: drag inside to move the mask. Ctrl+click its edge to add a point.${keyedSuffix(mask)}`,
          mods: 'Drag: move mask · Shift: fine · Ctrl+click edge: add point · Esc: cancel',
        }
      case 'maskSelect':
        return { hint: `${name}: click its outline to select it and show its points.`, mods: 'Click: select mask' }
      default:
        break
    }
  }
  const base = roamBaseHint(trackName, parentName)
  return {
    hint: masksShown && masks.length ? `${base} Click a mask's outline to select it.` : base,
    mods: ROAM_MODS,
  }
}
