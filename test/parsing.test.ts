import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseRepo } from '../src/config.js';
import { parseJson } from '../src/llm.js';
import { detectLanguage } from '../src/runtime.js';
import { parseJunit } from '../src/suite.js';
import { firstCodeBlock, firstPythonBlock } from '../src/steps/test.js';

describe('parseJunit', () => {
  it('reads outcomes and failure text', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.repro.test_issue_2" name="test_issue_2"><failure message="assert 4.99 == 0.0">def test_issue_2():
&gt;       assert quote(50.00, "DE") == 0.00
E       assert 4.99 == 0.0</failure></testcase>
<testcase classname="t" name="test_ok"/>
<testcase classname="t" name="test_skip"><skipped message="x"/></testcase>
<testcase classname="t" name="test_err"><error message="boom">E   ImportError: x</error></testcase>
</testsuite></testsuites>`;
    const cases = parseJunit(xml);
    expect(cases.map((c) => [c.name, c.outcome])).toEqual([
      ['test_issue_2', 'failure'], ['test_ok', 'passed'], ['test_skip', 'skipped'], ['test_err', 'error'],
    ]);
    expect(cases[0]!.failureText).toContain('E       assert 4.99 == 0.0');
    expect(cases[0]!.failureText).toContain('assert quote(50.00, "DE")');
  });
});

describe('parseJson', () => {
  it('reads plain, fenced and reasoning-prefixed answers', () => {
    expect(parseJson('{"trivial": true, "reason": "x"}')).toEqual({ trivial: true, reason: 'x' });
    expect(parseJson('```json\n{"verdict": "good", "reasons": []}\n```')).toEqual({ verdict: 'good', reasons: [] });
    expect(parseJson('<think>hmm {no}</think>\nSure: {"a": 1}')).toEqual({ a: 1 });
    expect(parseJson('no json here')).toBeUndefined();
  });
});

it('firstPythonBlock takes the first python block', () => {
  expect(firstPythonBlock('x\n```python\ndef test_a():\n    assert 1\n```\n```python\nother\n```')).toBe('def test_a():\n    assert 1\n');
  expect(firstPythonBlock('```\nno lang\n```')).toBeNull();
});

it('firstCodeBlock accepts typescript fences', () => {
  expect(firstCodeBlock('```typescript\nexpect(1).toBe(2)\n```', 'typescript')).toBe('expect(1).toBe(2)\n');
  expect(firstCodeBlock('```ts\nconst x = 1\n```', 'typescript')).toBe('const x = 1\n');
  expect(firstCodeBlock('```python\nx\n```', 'typescript')).toBeNull();
});

it('detectLanguage prefers typescript when package.json has vitest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lang-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: { vitest: '2.0.0', typescript: '5.0.0' },
    }));
    expect(detectLanguage(dir)).toBe('typescript');
    writeFileSync(join(dir, 'requirements.txt'), 'pytest\n');
    expect(detectLanguage(dir)).toBe('typescript');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('normaliseRepo accepts names and URLs', () => {
  for (const r of ['o/r', 'https://github.com/o/r', 'https://github.com/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r/']) {
    expect(normaliseRepo(r)).toBe('o/r');
  }
  expect(() => normaliseRepo('not a repo')).toThrow();
});
