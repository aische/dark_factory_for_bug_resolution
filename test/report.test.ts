import { describe, expect, it } from 'vitest';
import { parseReport } from '../src/report.js';

const body = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => `### ${k}\n\n${v}\n`).join('\n');

const T1 = {
  Component: 'shipping',
  Description: 'Orders of exactly 50.00 to DE should ship free.',
  Input: '{"cart_total": 50.00, "country": "DE"}',
  Expected: '0.00',
  Actual: '4.99',
};

describe('parseReport', () => {
  it('parses a complete report', () => {
    const r = parseReport(2, 'Free shipping', body(T1));
    expect(r).toEqual({
      ok: true,
      report: {
        number: 2, title: 'Free shipping', component: 'shipping',
        description: T1.Description, input: { cart_total: 50, country: 'DE' }, expected: 0, actual: 4.99,
      },
    });
  });

  it('accepts a fenced JSON input', () => {
    const r = parseReport(2, 't', body({ ...T1, Input: '```json\n{"price": 12.50}\n```' }));
    expect(r.ok && r.report.input).toEqual({ price: 12.5 });
  });

  it('rejects N2: unquoted, non-JSON values', () => {
    const r = parseReport(1, 't', body({ ...T1, Input: 'a big order', Expected: 'the correct total', Actual: 'a wrong total' }));
    expect(r).toEqual({ ok: false, reason: 'Input is not JSON' });
    const r2 = parseReport(1, 't', body({ ...T1, Expected: 'the correct total' }));
    expect(r2).toEqual({ ok: false, reason: 'Expected is not a JSON scalar (strings must be quoted)' });
  });

  it('rejects missing and empty fields', () => {
    const { Actual: _, ...rest } = T1;
    expect(parseReport(1, 't', body(rest))).toEqual({ ok: false, reason: 'field Actual is missing' });
    expect(parseReport(1, 't', body({ ...T1, Description: '_No response_' }))).toEqual({
      ok: false, reason: 'field Description has no response',
    });
  });

  it('rejects non-scalar input values, arrays and equal values', () => {
    expect(parseReport(1, 't', body({ ...T1, Input: '{"items": [1]}' })).ok).toBe(false);
    expect(parseReport(1, 't', body({ ...T1, Input: '[1, 2]' })).ok).toBe(false);
    expect(parseReport(1, 't', body({ ...T1, Expected: '{"a": 1}' })).ok).toBe(false);
    expect(parseReport(1, 't', body({ ...T1, Actual: '0' }))).toEqual({ ok: false, reason: 'Expected equals Actual' });
  });

  it('keeps quoted strings as strings', () => {
    const r = parseReport(6, 't', body({ ...T1, Expected: '"SAVE10"', Actual: '"save10"' }));
    expect(r.ok && [r.report.expected, r.report.actual]).toEqual(['SAVE10', 'save10']);
  });
});
