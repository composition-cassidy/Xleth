// Theme-file validator. Called by ThemeLoader before applying a theme, and
// by ThemeWriter before persisting. Non-throwing — returns a structured
// ValidationResult so callers can decide whether to fall back to the default
// theme (boot path) or surface a user-facing error (editor save path).
//
// Forward-compat policy (spec §4): unknown token names produce a `warning`,
// not an `error`. This keeps older releases able to load themes authored
// against future catalogs.

import { TOKENS_BY_NAME, BASE_TOKEN_NAMES_SET, DERIVED_FORMULA_TOKEN_NAMES_SET } from '../tokens/catalog';
import {
  CURRENT_SCHEMA_VERSION,
  isGradientValue,
  type GradientValue,
  type ThemeFile,
  type TokenValue,
  type ValidationIssue,
  type ValidationResult,
} from './types';

// ──────────────────────────────────────────────────────────────────────────
// Value-syntax checks
// ──────────────────────────────────────────────────────────────────────────

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*(?:\d*\.?\d+)\s*)?\)$/;
const HSL_RE = /^hsla?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*(?:,\s*(?:\d*\.?\d+)\s*)?\)$/;
const VAR_RE = /^var\(\s*--[a-zA-Z0-9-]+\s*(?:,[^)]*)?\)$/;
const DIM_RE = /^-?\d+(?:\.\d+)?(px|em|rem|%|vh|vw|ch|fr|s|ms)$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

function isColorLiteral(v: string): boolean {
  return HEX_RE.test(v) || RGB_RE.test(v) || HSL_RE.test(v) || VAR_RE.test(v);
}

function isDimensionLiteral(v: string): boolean {
  return DIM_RE.test(v) || VAR_RE.test(v) || NUMBER_RE.test(v);
}

// ──────────────────────────────────────────────────────────────────────────
// Validators
// ──────────────────────────────────────────────────────────────────────────

function validateGradient(v: GradientValue, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(v.stops) || v.stops.length < 2) {
    issues.push({ severity: 'error', path, message: 'gradient must have at least 2 stops' });
    return;
  }
  v.stops.forEach((s, i) => {
    const p = `${path}.stops[${i}]`;
    if (typeof s.color !== 'string' || !isColorLiteral(s.color)) {
      issues.push({ severity: 'error', path: `${p}.color`, message: `invalid color "${String(s.color)}"` });
    }
    if (typeof s.position !== 'number' || !Number.isFinite(s.position)) {
      issues.push({ severity: 'error', path: `${p}.position`, message: 'position must be a finite number' });
    } else if (s.position < 0 || s.position > 100) {
      issues.push({ severity: 'warning', path: `${p}.position`, message: `position ${s.position} outside 0–100; will be clamped` });
    }
  });
}

function validateTokenValue(
  name: string,
  value: TokenValue,
  issues: ValidationIssue[],
): void {
  const path = `tokens.${name}`;
  const def = TOKENS_BY_NAME[name];

  // Forward-compat: unknown token names are a warning, not an error.
  if (!def) {
    issues.push({ severity: 'warning', path, message: `unknown token (ignored by this build)` });
    // Still sanity-check the value shape so a broken file doesn't slip through.
    if (typeof value !== 'string' && !isGradientValue(value)) {
      issues.push({ severity: 'error', path, message: 'value must be a string or gradient object' });
    }
    return;
  }

  // Gradient-capability gate.
  if (isGradientValue(value)) {
    if (def.capability === 'solid') {
      issues.push({ severity: 'error', path, message: `token "${name}" does not accept gradients` });
      return;
    }
    if (def.capability === 'linear' && value.type !== 'linear-gradient') {
      issues.push({ severity: 'error', path, message: `token "${name}" accepts linear gradients only, got ${value.type}` });
      return;
    }
    validateGradient(value, path, issues);
    return;
  }

  // String value.
  if (typeof value !== 'string') {
    issues.push({ severity: 'error', path, message: 'value must be a string or gradient object' });
    return;
  }

  switch (def.kind) {
    case 'color':
      if (!isColorLiteral(value)) {
        issues.push({ severity: 'error', path, message: `invalid color literal "${value}"` });
      }
      break;
    case 'dimension':
      if (!isDimensionLiteral(value)) {
        issues.push({ severity: 'error', path, message: `invalid dimension "${value}"` });
      }
      break;
    case 'duration':
      if (!VAR_RE.test(value) && !/^-?\d+(?:\.\d+)?(s|ms)(?:\s+[a-z-]+)?$/.test(value)) {
        issues.push({ severity: 'error', path, message: `invalid duration "${value}"` });
      }
      break;
    case 'opacity':
      if (!VAR_RE.test(value) && !/^(?:0|1|0?\.\d+)$/.test(value)) {
        issues.push({ severity: 'error', path, message: `invalid opacity "${value}" (expected 0..1)` });
      }
      break;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate a parsed theme file. Always returns a result; never throws.
 * Callers decide how to treat `warning` issues.
 */
export function validateTheme(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (typeof input !== 'object' || input === null) {
    return { valid: false, issues: [{ severity: 'error', path: '', message: 'theme file must be an object' }] };
  }
  const t = input as Partial<ThemeFile>;

  if (typeof t.schemaVersion !== 'number') {
    issues.push({ severity: 'error', path: 'schemaVersion', message: 'missing or non-numeric' });
  } else if (t.schemaVersion > CURRENT_SCHEMA_VERSION) {
    issues.push({
      severity: 'warning',
      path: 'schemaVersion',
      message: `file uses schemaVersion ${t.schemaVersion}; this build supports ${CURRENT_SCHEMA_VERSION}`,
    });
  }

  if (typeof t.name !== 'string' || t.name.length === 0) {
    issues.push({ severity: 'error', path: 'name', message: 'missing' });
  }

  if (t.tokens !== undefined && (typeof t.tokens !== 'object' || t.tokens === null)) {
    issues.push({ severity: 'error', path: 'tokens', message: 'must be an object' });
  }
  if (t.derivationDetached !== undefined && !Array.isArray(t.derivationDetached)) {
    issues.push({ severity: 'error', path: 'derivationDetached', message: 'must be an array' });
  }

  // Short-circuit if the shell is broken — further checks would be noisy.
  if (issues.some(i => i.severity === 'error')) {
    return { valid: false, issues };
  }

  // Per-token validation.
  const tokens = (t.tokens ?? {}) as Record<string, TokenValue>;
  for (const [name, value] of Object.entries(tokens)) {
    if (!name.startsWith('--theme-')) {
      issues.push({ severity: 'error', path: `tokens.${name}`, message: 'token name must start with --theme-' });
      continue;
    }
    validateTokenValue(name, value, issues);
  }

  // derivationDetached: each entry must be a known derived-formula token.
  const detached = (t.derivationDetached ?? []) as string[];
  for (let i = 0; i < detached.length; i++) {
    const name = detached[i];
    if (typeof name !== 'string') {
      issues.push({ severity: 'error', path: `derivationDetached[${i}]`, message: 'must be a string' });
      continue;
    }
    if (BASE_TOKEN_NAMES_SET.has(name)) {
      issues.push({ severity: 'error', path: `derivationDetached[${i}]`, message: `"${name}" is a base token; it can't be detached` });
      continue;
    }
    if (!DERIVED_FORMULA_TOKEN_NAMES_SET.has(name)) {
      issues.push({ severity: 'warning', path: `derivationDetached[${i}]`, message: `"${name}" is not a derived-formula token in this build; ignored` });
    }
  }

  const hasErrors = issues.some(i => i.severity === 'error');
  return { valid: !hasErrors, issues };
}
