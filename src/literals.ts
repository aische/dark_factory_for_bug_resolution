import type { Scalar } from './report.js';

// A number not glued to an identifier, so `test_issue_12` does not count as 12.
const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w])/g;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `text` contains `value` as a Python literal (C-TEST-3): numbers within 1e-9,
 * strings in either quote style, true/false/null as True/False/None.
 */
export function containsLiteral(text: string, value: Scalar): boolean {
  if (value === null) return /\bNone\b/.test(text);
  if (typeof value === 'boolean') return new RegExp(`\\b${value ? 'True' : 'False'}\\b`).test(text);
  if (typeof value === 'number') {
    return [...text.matchAll(NUMBER)].some((m) => Math.abs(Number(m[0]) - value) <= 1e-9);
  }
  const quoted = [`"${value}"`, `'${value}'`, JSON.stringify(value), `'${value.replace(/'/g, "\\'")}'`];
  return quoted.some((q) => new RegExp(escapeRegex(q)).test(text));
}

/** Lines of a test source that start with `assert`. */
export function assertLines(source: string): string {
  return source
    .split('\n')
    .filter((l) => l.trimStart().startsWith('assert'))
    .join('\n');
}

/** The `E ` lines of a pytest failure. */
export function errorLines(failureText: string): string[] {
  return failureText.split('\n').filter((l) => /^E\s/.test(l));
}

export const pyLiteral = (v: Scalar): string =>
  v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : JSON.stringify(v);
