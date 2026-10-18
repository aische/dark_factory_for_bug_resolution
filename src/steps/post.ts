import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import picomatch from 'picomatch';
import type { DiffPolicy } from '../config.js';
import {
  branchName, issueDir, record, stopped, type RunContext, type Step, type StepResult, type Stop,
} from '../context.js';
import { clone, commitAll, fetchBranchBack, git, gitOk } from '../git.js';
import { judge } from '../llm.js';
import type { Verdict } from '../log.js';
import { runPytest, summarize } from '../pytest.js';
import { formatReport, type BugReport } from '../report.js';
import type { FixerDiff } from './fix.js';
import type { LockedTest } from './test.js';

const JUDGE_SYSTEM =
  'You review a bug fix as a strict senior reviewer. All tests, including the reproducing test, already pass. Judge whether the implementation is written well. It is bad if any of these hold: it special-cases the test\'s input values or hardcodes the expected answer; it works around configuration or data in code instead of fixing the cause; it changes behaviour unrelated to the report; it adds dead code, debug output or commented-out code; it does not read like the surrounding code (naming, idiom, structure, comment density); it is larger than the fix needs; it obviously breaks inputs the old code handled, for example by calling a method on a value that can be missing. Answer JSON {"verdict": "good" | "bad", "reasons": string[]}. Give reasons for either verdict.';

export interface AddedLine {
  path: string;
  line: number;
  text: string;
}

export interface ParsedPatch {
  paths: string[];
  hunks: number;
  added: AddedLine[];
  binary: boolean;
  symlink: boolean;
  fileOps: string[];
}

function unquote(p: string): string {
  const s = p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) as string : p;
  return s.replace(/^[ab]\//, '');
}

export function parsePatch(patch: string): ParsedPatch {
  const paths = new Set<string>();
  const added: AddedLine[] = [];
  const fileOps: string[] = [];
  let hunks = 0;
  let binary = false;
  let symlink = false;
  let file = '';
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split('\n')) {
    if (inHunk) {
      if (line.startsWith('+')) {
        added.push({ path: file, line: newLine++, text: line.slice(1) });
        continue;
      }
      if (line.startsWith(' ')) { newLine++; continue; }
      if (line.startsWith('-') || line.startsWith('\\')) continue;
      inHunk = false;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      hunks++;
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(line))) {
      file = unquote(m[2]!);
      paths.add(unquote(m[1]!));
      paths.add(file);
    } else if ((m = /^(?:---|\+\+\+) (.+)$/.exec(line))) {
      if (m[1] !== '/dev/null') {
        const p = unquote(m[1]!.replace(/\t.*$/, ''));
        paths.add(p);
        if (line.startsWith('+++')) file = p;
      }
    } else if ((m = /^(rename|copy) (from|to) (.+)$/.exec(line))) {
      paths.add(unquote(m[3]!));
      fileOps.push(`${m[1]} ${m[3]}`);
    } else if ((m = /^(new file|deleted file|old|new) mode (\d+)/.exec(line))) {
      fileOps.push(`${m[1]} mode ${m[2]} ${file}`);
      if (m[2] === '120000') symlink = true;
    } else if (/^index \S+ 120000/.test(line)) {
      symlink = true;
    } else if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      binary = true;
    }
  }
  return { paths: [...paths], hunks, added, binary, symlink, fileOps };
}

export interface DiffCheckInput {
  patch: string;
  /** Output of `git apply --numstat --summary`. */
  applyStat: string;
  /** sha256 of the repro test after applying, null if it is gone. */
  testHash: string | null;
  lockedHash: string;
  policy: DiffPolicy;
  secrets: { env: string; value: string }[];
}

export interface DiffCheckResult {
  verdict: 'pass' | 'fail';
  check: string;
  reason: string;
  files: string[];
  lines: number;
  hunks: number;
}

const isTestPath = (p: string) => {
  const name = basename(p);
  return p.startsWith('tests/') || /^test_.*\.py$/.test(name) || /_test\.py$/.test(name) || name === 'conftest.py';
};

const IMPORT = /^\+\s*(import\s|from\s+\S+\s+import\s)/;

/** Deterministic diff checks (C-POST-2). First failure wins. */
export function checkDiff(input: DiffCheckInput): DiffCheckResult {
  const p = parsePatch(input.patch);
  const files = p.paths;
  let lines = 0;
  let binaryStat = false;
  for (const row of input.applyStat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(row);
    if (!m) continue;
    if (m[1] === '-' || m[2] === '-') binaryStat = true;
    else lines += Number(m[1]) + Number(m[2]);
  }
  const summaryOps = input.applyStat
    .split('\n')
    .filter((row) => /^\s+(create|delete|rename|copy|mode change)\b/.test(row))
    .map((row) => row.trim());
  const result = (check: string, reason: string, verdict: 'pass' | 'fail' = 'fail'): DiffCheckResult =>
    ({ verdict, check, reason, files, lines, hunks: p.hunks });
  const { policy } = input;

  const test = files.find(isTestPath);
  if (test) return result('tests untouched', `diff changes test file ${test}`);

  if (input.testHash !== input.lockedHash) {
    return result('locked hash', input.testHash ? 'repro test does not match the locked hash' : 'repro test is missing');
  }

  for (const path of files) {
    const pattern = policy.protectedPaths.find((g) => picomatch.isMatch(path, g, { dot: true }));
    if (pattern) return result('protected paths', `diff changes protected path ${path} (${pattern})`);
  }

  const outside = files.find((f) => !picomatch.isMatch(f, policy.allowedPaths, { dot: true }));
  if (outside) return result('allowed paths', `${outside} is outside ${policy.allowedPaths.join(', ')}`);

  if (p.binary || binaryStat) return result('file operations', 'diff contains a binary file');
  if (p.symlink) return result('file operations', 'diff contains a symlink');
  const op = summaryOps[0] ?? p.fileOps[0];
  if (op) return result('file operations', `diff has a file operation: ${op}`);

  if (files.length > policy.maxFiles) return result('size', `${files.length} files changed, max ${policy.maxFiles}`);
  if (lines > policy.maxChangedLines) return result('size', `${lines} lines changed, max ${policy.maxChangedLines}`);
  if (p.hunks > policy.maxHunks) return result('size', `${p.hunks} hunks, max ${policy.maxHunks}`);

  const imp = p.added.find((a) => IMPORT.test('+' + a.text) || a.text.includes('__import__(') || a.text.includes('importlib'));
  if (imp) return result('no new imports', `new import at ${imp.path}:${imp.line}`);

  const patterns = policy.secretPatterns.map((s) => ({ s, re: new RegExp(s, 'i') }));
  for (const a of p.added) {
    const pat = patterns.find(({ re }) => re.test(a.text));
    if (pat) return result('no secrets', `possible secret at ${a.path}:${a.line} (pattern ${pat.s})`);
    const key = input.secrets.find(({ value }) => value && a.text.includes(value));
    if (key) return result('no secrets', `value of ${key.env} at ${a.path}:${a.line}`);
  }

  const noun = files.length === 1 ? 'file' : 'files';
  return result('ok', `${files.length} ${noun}, ${lines} lines, ${files.join(', ')}`, 'pass');
}

/** Diff checks on a patch already applied in the working copy `cwd`. */
export async function diffChecksIn(
  ctx: RunContext, n: number, step: Step, cwd: string, patchPath: string, test: LockedTest,
): Promise<{ stop?: Stop; reason: string }> {
  const patch = readFileSync(patchPath, 'utf8');
  const stat = await git(cwd, ['apply', '--numstat', '--summary', patchPath]);
  const testFile = join(cwd, test.path);
  const testHash = existsSync(testFile) ? createHash('sha256').update(readFileSync(testFile)).digest('hex') : null;
  const res = checkDiff({
    patch, applyStat: stat.stdout, testHash, lockedHash: test.sha256, policy: ctx.policy.diff, secrets: ctx.secrets,
  });
  const stop = record(ctx, n, step, 'diff', res.verdict, res.reason,
    { check: res.check, files: res.files, lines: res.lines, hunks: res.hunks }, res.check);
  return { stop, reason: res.reason };
}

/** Repro test green in every run and the full suite green once (C-POST-3). */
export async function testsIn(
  ctx: RunContext, n: number, step: Step, cwd: string, test: LockedTest, tag: string,
): Promise<{ stop?: Stop; reason: string }> {
  const runs = ctx.policy.test.runs;
  const junit = (name: string) => join(issueDir(ctx, n), 'junit', `${tag}-${name}.xml`);
  const base = { cwd, venvDir: ctx.venvDir, timeoutSec: ctx.policy.tests.timeoutSec };
  const evidence: Record<string, unknown>[] = [];
  let green = 0;
  let verdict: Verdict = 'pass';
  let reason = '';
  for (let i = 1; i <= runs; i++) {
    const r = await runPytest({ ...base, junitPath: junit(`repro-${i}`), args: [test.path] });
    evidence.push({ run: i, ...summarize(r) });
    if (r.timedOut) { verdict = 'unknown'; reason = 'repro test timed out'; break; }
    if (r.exitCode === 0 && r.cases.length > 0 && r.cases.every((c) => c.outcome === 'passed')) green++;
  }
  if (verdict === 'pass' && green < runs) {
    verdict = green === 0 ? 'fail' : 'unknown';
    reason = `repro ${green}/${runs} green`;
  }
  if (verdict === 'pass') {
    const suite = await runPytest({ ...base, junitPath: junit('suite') });
    evidence.push({ suite: true, ...summarize(suite) });
    if (suite.timedOut) { verdict = 'unknown'; reason = 'suite timed out'; }
    else if (suite.exitCode !== 0) {
      verdict = 'fail';
      const failed = suite.cases.filter((c) => c.outcome === 'failure' || c.outcome === 'error').map((c) => c.name);
      reason = `suite red${failed.length ? `: ${failed.slice(0, 5).join(', ')}` : ` (exit ${suite.exitCode})`}`;
    } else reason = `repro ${runs}/${runs} green, suite green`;
  }
  const stop = record(ctx, n, step, 'tests', verdict, reason, { runs: evidence }, 'tests after fix');
  return { stop, reason };
}

export interface Verified {
  dir: string;
  fixSha: string;
  diffReason: string;
  testsReason: string;
  judgeReason: string;
}

/** Apply, commit, check, judge and push the fix (C-POST-1..5). */
export async function postStep(
  ctx: RunContext, r: BugReport, test: LockedTest, fix: FixerDiff,
): Promise<StepResult<Verified>> {
  const n = r.number;
  const branch = branchName(n);
  const dir = join(issueDir(ctx, n), 'verify');
  await clone(ctx.repoDir, dir, branch);

  const check = await git(dir, ['apply', '--check', fix.patchPath]);
  const applyStop = check.exitCode === 0
    ? undefined
    : record(ctx, n, 'post', 'apply', 'fail', `diff does not apply: ${check.stderr.trim().split('\n')[0]}`, {}, 'apply diff');
  if (applyStop) return stopped(applyStop);

  // The checks read the files after applying, so apply first, then decide.
  await gitOk(dir, ['apply', fix.patchPath]);
  const diff = await diffChecksIn(ctx, n, 'post', dir, fix.patchPath, test);
  if (diff.stop) return stopped(diff.stop);

  const fp = ctx.fixerProvider;
  const message = [
    `Fix #${n}: ${r.title}`,
    '',
    `Factory-Run: ${ctx.runId}`,
    `Fixer: ${ctx.fixer.name} (${fp.name}/${fp.model})`,
    `Test-SHA256: ${test.sha256}`,
  ].join('\n');
  const fixSha = await commitAll(dir, message, ctx.policy.git);
  ctx.log.write({ issue: n, step: 'post', check: 'commit', reason: `fix commit ${fixSha.slice(0, 7)}`, evidence: { sha: fixSha, message } });

  const tests = await testsIn(ctx, n, 'post', dir, test, 'post');
  if (tests.stop) return stopped(tests.stop);

  const changed = parsePatch(fix.patch).paths;
  const contents = changed
    .filter((p) => existsSync(join(dir, p)))
    .map((p) => `--- ${p} ---\n${readFileSync(join(dir, p), 'utf8')}`)
    .join('\n');
  const judgeUser = [
    formatReport(r),
    `Reproducing test (${test.path}):\n${test.source}`,
    `Diff:\n${fix.patch}`,
    `Changed files after the fix:\n${contents}`,
  ].join('\n\n');
  const j = await judge(ctx.llm, JUDGE_SYSTEM, judgeUser);
  const judgeStop = record(ctx, n, 'post', 'judge', j.verdict,
    j.verdict === 'pass' ? j.reason : [j.reason, ...j.reasons.slice(1)].join('; '),
    { prompt: { system: JUDGE_SYSTEM, user: judgeUser }, answer: j.raw ?? null, reasons: j.reasons }, 'fix judge');
  if (judgeStop) return stopped(judgeStop);

  await fetchBranchBack(ctx.repoDir, dir, branch);
  const pushed = await ctx.gh.push(n, ctx.repoDir, ['origin', `${branch}:refs/heads/${branch}`]);
  if (!pushed.ok) return stopped(record(ctx, n, 'post', 'push', 'unknown', pushed.reason, {}, 'push branch')!);

  return {
    ok: true,
    value: { dir, fixSha, diffReason: diff.reason, testsReason: tests.reason, judgeReason: j.reason },
  };
}
