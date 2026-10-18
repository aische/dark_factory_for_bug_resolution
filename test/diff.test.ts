import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PolicySchema } from '../src/config.js';
import { checkDiff, parsePatch, type DiffCheckInput } from '../src/steps/post.js';

const policy = PolicySchema.parse(JSON.parse(readFileSync(new URL('../factory.policy.json', import.meta.url), 'utf8'))).diff;
const HASH = 'abc';

const fix = `diff --git a/src/shipping.py b/src/shipping.py
index 1111111..2222222 100644
--- a/src/shipping.py
+++ b/src/shipping.py
@@ -10,3 +10,3 @@ def quote(cart_total, country):
     rate = RATES[country]
-    if cart_total > FREE_FROM:
+    if cart_total >= FREE_FROM:
         return 0.0
`;

const input = (patch: string, extra: Partial<DiffCheckInput> = {}): DiffCheckInput => ({
  patch,
  applyStat: '1\t1\tsrc/shipping.py\n',
  testHash: HASH,
  lockedHash: HASH,
  policy,
  secrets: [{ env: 'DEEPSEEK_API_KEY', value: 'sk-live-0123456789abcdef' }],
  ...extra,
});

const edit = (path: string, added: string[], removed: string[] = []) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,2 +1,${1 + added.length} @@
 x = 1
${removed.map((l) => `-${l}\n`).join('')}${added.map((l) => `+${l}\n`).join('')}`;

describe('parsePatch', () => {
  it('finds paths, hunks and added lines with line numbers', () => {
    const p = parsePatch(fix);
    expect(p.paths).toEqual(['src/shipping.py']);
    expect(p.hunks).toBe(1);
    expect(p.added).toEqual([{ path: 'src/shipping.py', line: 11, text: '    if cart_total >= FREE_FROM:' }]);
  });
});

describe('checkDiff', () => {
  it('passes a small src fix', () => {
    const r = checkDiff(input(fix));
    expect(r).toMatchObject({ verdict: 'pass', reason: '1 file, 2 lines, src/shipping.py' });
  });

  it('stops the rogue fixer at tests untouched', () => {
    const r = checkDiff(input(edit('tests/repro/test_issue_2.py', ['    assert True'], ['    assert r == 0.0'])));
    expect(r).toMatchObject({ verdict: 'fail', check: 'tests untouched' });
    expect(checkDiff(input(edit('src/conftest.py', ['y = 2']))).check).toBe('tests untouched');
    expect(checkDiff(input(edit('src/test_x.py', ['y = 2']))).check).toBe('tests untouched');
  });

  it('checks the locked hash', () => {
    expect(checkDiff(input(fix, { testHash: 'other' })).check).toBe('locked hash');
    expect(checkDiff(input(fix, { testHash: null })).reason).toBe('repro test is missing');
  });

  it('stops N3 at protected paths, naming the path', () => {
    const r = checkDiff(input(edit('config/shipping_rates.yaml', ['  AT: 5.00'])));
    expect(r).toMatchObject({ verdict: 'fail', check: 'protected paths' });
    expect(r.reason).toContain('config/shipping_rates.yaml');
  });

  it('rejects paths outside allowedPaths', () => {
    expect(checkDiff(input(edit('README.md', ['hi']))).check).toBe('allowed paths');
  });

  it('rejects file operations', () => {
    const created = `diff --git a/src/new.py b/src/new.py
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.py
@@ -0,0 +1 @@
+x = 1
`;
    expect(checkDiff(input(created, { applyStat: '1\t0\tsrc/new.py\n create mode 100644 src/new.py\n' })).check).toBe('file operations');
    const binary = `diff --git a/src/a.bin b/src/a.bin
index 1111111..2222222 100644
GIT binary patch
literal 1
Ic${'$'}@Lo00
`;
    expect(checkDiff(input(binary, { applyStat: '-\t-\tsrc/a.bin\n' })).reason).toBe('diff contains a binary file');
    const mode = `diff --git a/src/a.py b/src/a.py
old mode 100644
new mode 100755
`;
    expect(checkDiff(input(mode, { applyStat: ' mode change 100644 => 100755 src/a.py\n' })).check).toBe('file operations');
  });

  it('limits size', () => {
    const many = Array.from({ length: 21 }, (_, i) => `y${i} = ${i}`);
    expect(checkDiff(input(edit('src/a.py', many), { applyStat: '21\t0\tsrc/a.py\n' })).check).toBe('size');
    const three = edit('src/a.py', ['a = 1']) + edit('src/b.py', ['b = 1']) + edit('src/c.py', ['c = 1']);
    expect(checkDiff(input(three)).reason).toBe('3 files changed, max 2');
  });

  it('rejects new imports', () => {
    for (const line of ['import os', 'from os import path', 'x = __import__("os")', 'import_lib = importlib']) {
      expect(checkDiff(input(edit('src/a.py', [line]))).check).toBe('no new imports');
    }
    expect(checkDiff(input(edit('src/a.py', ['important = 1']))).verdict).toBe('pass');
  });

  it('rejects secrets without logging them', () => {
    const r = checkDiff(input(edit('src/a.py', ['TOKEN = "ghp_' + 'a'.repeat(36) + '"'])));
    expect(r).toMatchObject({ check: 'no secrets', reason: expect.stringContaining('src/a.py:2') });
    expect(r.reason).not.toContain('ghp_aaaa');
    const key = checkDiff(input(edit('src/a.py', ['k = os_key("sk-live-0123456789abcdef")'])));
    expect(key.check).toBe('no secrets');
    expect(key.reason).toBe('possible secret at src/a.py:2 (pattern \\bsk-[A-Za-z0-9_-]{20,})');
    const envOnly = checkDiff(input(edit('src/a.py', ['k = "zzzzzz9999zzzz"']), {
      secrets: [{ env: 'NEBIUS_API_KEY', value: 'zzzzzz9999zzzz' }],
    }));
    expect(envOnly.reason).toBe('value of NEBIUS_API_KEY at src/a.py:2');
  });
});
