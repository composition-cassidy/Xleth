// Theme-file schema types — the on-disk shape that xleth-default.json and
// user-authored themes must conform to. Per spec §4.
//
// A theme file is JSON. It lists (1) the 5 base tokens, (2) any overrides for
// derived/explicit tokens, (3) any tokens the user has detached from
// derivation, and (4) metadata. Token values are either CSS-string literals
// (hex, rgba, var-ref, etc.) or gradient objects that the compiler converts
// to a CSS string at apply time.

// ──────────────────────────────────────────────────────────────────────────
// Gradient value objects — spec §3.6
// ──────────────────────────────────────────────────────────────────────────

export interface GradientStop {
  /** Color in any CSS-parseable form: hex, rgba(), var(--...). */
  color: string;
  /** 0–100. Percent along the gradient axis. */
  position: number;
}

export interface LinearGradientValue {
  type: 'linear-gradient';
  /** CSS angle in degrees (0 = to top, 90 = to right, etc.). */
  angle: number;
  stops: GradientStop[];
}

export interface RadialGradientValue {
  type: 'radial-gradient';
  /** CSS shape — 'circle' | 'ellipse'. */
  shape?: 'circle' | 'ellipse';
  /** Keyword size or 'closest-side' | 'farthest-corner' etc. */
  size?: string;
  /** CSS position (e.g. 'center', '50% 50%', '20px 30px'). */
  position?: string;
  stops: GradientStop[];
}

export interface ConicGradientValue {
  type: 'conic-gradient';
  /** Start angle in degrees. */
  angle?: number;
  position?: string;
  stops: GradientStop[];
}

export type GradientValue = LinearGradientValue | RadialGradientValue | ConicGradientValue;

export function isGradientValue(v: unknown): v is GradientValue {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'linear-gradient' || t === 'radial-gradient' || t === 'conic-gradient';
}

// ──────────────────────────────────────────────────────────────────────────
// Token values — string literal OR gradient object
// ──────────────────────────────────────────────────────────────────────────

export type TokenValue = string | GradientValue;

// ──────────────────────────────────────────────────────────────────────────
// Theme file shape
// ──────────────────────────────────────────────────────────────────────────

export interface ThemeFile {
  /** Integer. Bumped when incompatible changes ship. Currently 1. */
  schemaVersion: number;
  /** Human-readable name; displayed in the theme picker. */
  name: string;
  /** Optional author string. */
  author?: string;
  /** Optional description/subtitle. */
  description?: string;
  /** If true, the theme is immutable — edits fork a copy. Shipped themes. */
  locked?: boolean;
  /**
   * Explicit token values. Any token name mapped here wins over derivation
   * (provided the token is listed in `derivationDetached` if it's in §3.2).
   * Keys MUST start with `--theme-`.
   */
  tokens: Record<string, TokenValue>;
  /**
   * Names of derived-formula tokens that the user has detached from
   * deriveTheme() — their value comes from `tokens` instead.
   */
  derivationDetached: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Validation result
// ──────────────────────────────────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  path: string;   // JSON-pointer-ish path, e.g. "tokens.--theme-accent"
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export const CURRENT_SCHEMA_VERSION = 1;
