import type { Scalar } from './report.js';

export type LiteralStyle = 'python' | 'js';

// A number not glued to an identifier, so `test_issue_12` does not count as 12.
const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w])/g;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `text` contains `value` as a language literal (C-TEST-3): numbers within 1e-9,
 * strings in either quote style; booleans/null as True/False/None (Python) or true/false/null (JS).
 */
export function containsLiteral(text: string, value: Scalar, style: LiteralStyle = 'python'): boolean {
  if (value === null) return style === 'python' ? /\bNone\b/.test(text) : /\bnull\b/.test(text);
  if (typeof value === 'boolean') {
    if (style === 'python') return new RegExp(`\\b${value ? 'True' : 'False'}\\b`).test(text);
    return new RegExp(`\\b${value}\\b`).test(text);
  }
  if (typeof value === 'number') {
    return [...text.matchAll(NUMBER)].some((m) => Math.abs(Number(m[0]) - value) <= 1e-9);
  }
  const quoted = [`"${value}"`, `'${value}'`, JSON.stringify(value), `'${value.replace(/'/g, "\\'")}'`];
  return quoted.some((q) => new RegExp(escapeRegex(q)).test(text));
}

/** Lines of a test source that start with `assert` (Python). */
export function assertLines(source: string): string {
  return source
    .split('\n')
    .filter((l) => l.trimStart().startsWith('assert'))
    .join('\n');
}

/** Lines that express an expectation in Vitest/Jest style. */
export function expectationLines(source: string): string {
  return source
    .split('\n')
    .filter((l) => /\bexpect\s*\(/.test(l) || /\.toBe\s*\(/.test(l) || /\.toEqual\s*\(/i.test(l) || /\.toStrictEqual\s*\(/.test(l))
    .join('\n');
}

/** The `E ` lines of a pytest failure. */
export function errorLines(failureText: string): string[] {
  return failureText.split('\n').filter((l) => /^E\s/.test(l));
}

export function formatLiteral(v: Scalar, style: LiteralStyle = 'python'): string {
  if (v === null) return style === 'python' ? 'None' : 'null';
  if (typeof v === 'boolean') {
    if (style === 'python') return v ? 'True' : 'False';
    return String(v);
  }
  return JSON.stringify(v);
}

/** @deprecated use formatLiteral(v, 'python') */
export const pyLiteral = (v: Scalar): string => formatLiteral(v, 'python');
