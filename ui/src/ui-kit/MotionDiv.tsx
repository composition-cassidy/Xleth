import { forwardRef, useCallback, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { useGhostExit, useMotionEnter } from './motion';
import type { GhostExitOptions, MotionRecipe } from './motion';

export interface MotionDivProps extends HTMLAttributes<HTMLDivElement> {
  /** The enter recipe (ui-kit/motion.css). What it looks like, and whether it moves at all, is the tier's call. */
  recipe: MotionRecipe;
  /**
   * Decided when the element mounts. False leaves it alone: pass "was the list already on screen"
   * so an item animates when it is ADDED, never when the whole list first draws.
   */
  enter?: boolean;
  /** Fade out where it stood when it unmounts (floating surfaces). Default false. */
  exit?: boolean | GhostExitOptions;
  /** The element to render. Default `div`. */
  as?: 'div' | 'section' | 'aside' | 'span' | 'li';
}

/**
 * A div that enters with a motion recipe when it mounts and, optionally, exits when it unmounts.
 * Give it a `key` to replay the enter when its content is swapped (a tab's panel, a settings
 * page). It adds no styles of its own.
 */
const MotionDiv = forwardRef<HTMLDivElement, MotionDivProps>(function MotionDiv(
  { recipe, enter = true, exit = false, as, ...rest },
  forwarded,
) {
  const own = useRef<HTMLDivElement | null>(null);
  const attrs = useMotionEnter(recipe, enter);
  useGhostExit(own, exit ? { ...(typeof exit === 'object' ? exit : null) } : { disabled: true });

  const setRef = useCallback((node: HTMLDivElement | null) => {
    own.current = node;
    if (typeof forwarded === 'function') forwarded(node);
    else if (forwarded) forwarded.current = node;
  }, [forwarded]);

  // Every allowed tag takes the same HTML attributes; the cast only quiets the union of ref types.
  const Tag = (as ?? 'div') as 'div';
  return <Tag {...rest} {...attrs} ref={setRef} />;
});

export default MotionDiv;
