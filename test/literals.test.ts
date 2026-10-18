import { describe, expect, it } from 'vitest';
import { assertLines, containsLiteral, errorLines, expectationLines } from '../src/literals.js';

describe('containsLiteral', () => {
  it('matches numbers numerically', () => {
    expect(containsLiteral('assert result == 0.00', 0)).toBe(true);
    expect(containsLiteral('assert result == 0', 0)).toBe(true);
    expect(containsLiteral('quote(50.0, "DE")', 50)).toBe(true);
    expect(containsLiteral('assert stock == -1', -1)).toBe(true);
    expect(containsLiteral('assert 11.95 == 11.96 ± 1.2e-05', 11.95)).toBe(true);
    expect(containsLiteral('assert x == 4.98', 4.99)).toBe(false);
  });

  it('does not take digits out of identifiers', () => {
    expect(containsLiteral('def test_issue_12():', 12)).toBe(false);
    expect(containsLiteral('x = v2', 2)).toBe(false);
  });

  it('matches strings in either quote style', () => {
    expect(containsLiteral(`country="DE"`, 'DE')).toBe(true);
    expect(containsLiteral(`country='DE'`, 'DE')).toBe(true);
    expect(containsLiteral(`country=DE`, 'DE')).toBe(false);
  });

  it('maps true/false/null to Python by default', () => {
    expect(containsLiteral('assert ok is True', true)).toBe(true);
    expect(containsLiteral('assert ok is False', true)).toBe(false);
    expect(containsLiteral('assert x is None', null)).toBe(true);
  });

  it('maps true/false/null for JavaScript', () => {
    expect(containsLiteral('expect(ok).toBe(true)', true, 'js')).toBe(true);
    expect(containsLiteral('expect(ok).toBe(True)', true, 'js')).toBe(false);
    expect(containsLiteral('expect(x).toBe(null)', null, 'js')).toBe(true);
    expect(containsLiteral('expect(x).toBe(None)', null, 'js')).toBe(false);
  });
});

it('assertLines and errorLines pick the right lines', () => {
  const src = 'def test_x():\n    result = f(1)\n    assert result == 2\n';
  expect(assertLines(src)).toBe('    assert result == 2');
  expect(errorLines('x\nE       assert 1 == 2\nE        +  where\n')).toEqual(['E       assert 1 == 2', 'E        +  where']);
});

it('expectationLines picks Vitest expect lines', () => {
  const src = `import { expect, it } from "vitest";
it("x", () => {
  const result = f(1);
  expect(result).toBe(2);
});
`;
  expect(expectationLines(src)).toContain('expect(result).toBe(2)');
});
