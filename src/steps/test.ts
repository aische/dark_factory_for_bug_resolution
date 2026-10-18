import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  branchName, issueDir, record, stopped, testPath, type RunContext, type StepResult,
} from '../context.js';
import { clone, commitAll, fetchBranchBack, gitOk, lsFiles } from '../git.js';
import { judge } from '../llm.js';
import type { Verdict } from '../log.js';
import type { SuiteResult } from '../runtime.js';
import { summarize } from '../runtime.js';
import { formatReport, type BugReport } from '../report.js';

const JUDGE_SYSTEM =
  'You review a reproducing test written for a bug report, as a strict senior reviewer. The test already fails on the current code with an assertion error. Judge whether it is written well. It is bad if any of these hold: it does not check the behaviour the report describes with the reported input and expected value; it asserts something trivially true or a side detail; its name does not say what it checks; it tests more than one behaviour; it contains loops, conditionals or helper logic it does not need; it does not follow the conventions of the example test (imports, fixtures, naming, assertion style); it mocks the code under test or depends on time, randomness, network or files. Answer JSON {"verdict": "good" | "bad", "reasons": string[]}. Give reasons for either verdict.';

const SRC_CAP = 100 * 1024;

export interface LockedTest {
  /** The test commit. */
  R: string;
  path: string;
  source: string;
  sha256: string;
  branchPushed: boolean;
  checksReason: string;
  judgeReason: string;
}

function readCapped(dir: string, files: string[], cap: number): string {
  let out = '';
  for (const f of files) {
    const content = readFileSync(join(dir, f), 'utf8');
    if (content.includes('\0')) continue;
    const block = `--- ${f} ---\n${content}\n`;
    if (out.length + block.length > cap) {
      out += block.slice(0, cap - out.length) + '\n[truncated]\n';
      break;
    }
    out += block;
  }
  return out;
}

/** The first test file outside the repro dir, as a style example. */
export function exampleTest(ctx: RunContext, files: string[]): { path: string; source: string } | null {
  return ctx.runtime.exampleTest(ctx.repoDir, files, ctx.policy.test.dir);
}

function generatePrompt(ctx: RunContext, r: BugReport, files: string[], path: string): string {
  const example = exampleTest(ctx, files);
  return [
    formatReport(r),
    `Files in the repository:\n${files.join('\n')}`,
    `Source files under src/:\n${readCapped(ctx.repoDir, files.filter((f) => f.startsWith('src/')), SRC_CAP)}`,
    example ? `Example test (${example.path}):\n${example.source}` : 'There is no existing test to use as an example.',
    ['Rules:', ...ctx.runtime.generateRules(r.number, path)].join('\n'),
  ].join('\n\n');
}

/** @deprecated use runtime.extractCodeBlock; kept for unit tests. */
export function firstPythonBlock(text: string): string | null {
  const m = /```python[^\n]*\n([\s\S]*?)```/.exec(text);
  return m ? m[1]!.replace(/\s*$/, '\n') : null;
}

export function firstCodeBlock(text: string, language: 'python' | 'typescript'): string | null {
  if (language === 'python') return firstPythonBlock(text);
  const ts = /```(?:typescript|ts|javascript)[^\n]*\n([\s\S]*?)```/.exec(text);
  return ts ? ts[1]!.replace(/\s*$/, '\n') : null;
}

/** One run of the repro test on base must fail on an assertion. */
function judgeRun(ctx: RunContext, r: SuiteResult): { verdict: Verdict; reason: string } {
  if (r.timedOut) return { verdict: 'unknown', reason: 'test timed out' };
  if (r.exitCode === 0) return { verdict: 'fail', reason: 'test passed on base' };
  if (r.exitCode !== 1) return { verdict: 'fail', reason: `test runner exited with ${r.exitCode}` };
  if (r.cases.length === 0) return { verdict: 'fail', reason: 'no testcase ran' };
  for (const c of r.cases) {
    if (c.outcome !== 'failure') return { verdict: 'fail', reason: `${c.name} ended with ${c.outcome}, not failure` };
    if (!ctx.runtime.isAssertionFailure(c.failureText)) {
      const hint = c.failureText.trim().split('\n')[0]?.slice(0, 120) ?? 'no failure text';
      return { verdict: 'fail', reason: `wrong failure reason: ${hint}` };
    }
  }
  return { verdict: 'pass', reason: 'fails with an assertion' };
}

/** Deterministic checks on base (C-TEST-3). Returns a Stop-ready result and the first run's failure text. */
async function runChecks(
  ctx: RunContext, r: BugReport, dir: string, path: string, source: string,
): Promise<{ verdict: Verdict; reason: string; evidence: Record<string, unknown>; failure: string }> {
  const runs = ctx.policy.test.runs;
  const results: SuiteResult[] = [];
  for (let i = 1; i <= runs; i++) {
    results.push(await ctx.runtime.runTests({
      cwd: dir,
      envDir: ctx.envDir,
      junitPath: join(issueDir(ctx, r.number), 'junit', `test-base-${i}.xml`),
      timeoutSec: ctx.policy.tests.timeoutSec,
      args: [path],
    }));
  }
  const judged = results.map((x) => judgeRun(ctx, x));
  const evidence: Record<string, unknown> = { runs: results.map((x, i) => ({ ...summarize(x), ...judged[i] })) };
  const failure = results[0]!.cases.map((c) => c.failureText).join('\n');
  const passes = judged.filter((j) => j.verdict === 'pass').length;
  if (passes > 0 && passes < runs) {
    return { verdict: 'unknown', reason: `flaky: failed with an assertion in ${passes}/${runs} runs`, evidence, failure };
  }
  if (passes === 0) {
    const first = judged[0]!;
    const same = judged.filter((j) => j.reason === first.reason).length;
    const verdict = judged.some((j) => j.verdict === 'unknown') ? 'unknown' : 'fail';
    return { verdict, reason: `${first.reason} in ${same}/${runs} runs`, evidence, failure };
  }

  const failureSearch = results[0]!.cases.map((c) => ctx.runtime.failureSearchText(c.failureText)).join('\n');
  const problem = ctx.runtime.sourceProblem(source, r.input, r.expected, r.actual, failureSearch);
  if (problem) return { verdict: 'fail', reason: problem, evidence, failure };

  return { verdict: 'pass', reason: `fails ${runs}/${runs} on base with an assertion`, evidence, failure };
}

/** Generate, commit, check, judge, lock and push the reproducing test (C-TEST-1..5). */
export async function testStep(ctx: RunContext, r: BugReport): Promise<StepResult<LockedTest>> {
  const n = r.number;
  const path = testPath(ctx, n);
  const branch = branchName(n);
  const files = await lsFiles(ctx.repoDir);
  const { runtime } = ctx;

  const prompt = generatePrompt(ctx, r, files, path);
  const answer = await ctx.llm.complete(runtime.generateSystem, prompt);
  const source = answer.ok ? runtime.extractCodeBlock(answer.text) : null;
  const fence = runtime.language === 'python' ? '```python' : '```typescript';
  const gen = record(ctx, n, 'test', 'generate', source ? 'pass' : 'unknown',
    !answer.ok ? answer.error : source ? `wrote ${path}` : `no ${fence} block in the answer`,
    { prompt: { system: runtime.generateSystem, user: prompt }, answer: answer.ok ? answer.text : null, source },
    'generate test');
  if (gen || !source) return stopped(gen!);

  const dir = join(issueDir(ctx, n), 'test');
  await clone(ctx.repoDir, dir);
  runtime.prepareCheckout(ctx.envDir, dir);
  await gitOk(dir, ['checkout', '--quiet', '-b', branch, ctx.baseSha]);
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), source);
  const R = await commitAll(dir, `Add reproducing test for #${n}`, ctx.policy.git);
  ctx.log.write({ issue: n, step: 'test', check: 'commit', reason: `${branch} at ${R.slice(0, 7)}`, evidence: { branch, sha: R } });

  const checks = await runChecks(ctx, r, dir, path, source);
  const checksStop = record(ctx, n, 'test', 'checks', checks.verdict, checks.reason, checks.evidence, 'test checks');
  if (checksStop) return stopped(checksStop);

  const example = exampleTest(ctx, files);
  const judgeUser = [
    formatReport(r),
    example ? `Example test (${example.path}):\n${example.source}` : 'There is no example test.',
    `Reproducing test (${path}):\n${source}`,
    `Failure output on the current code:\n${checks.failure}`,
  ].join('\n\n');
  const j = await judge(ctx.llm, JUDGE_SYSTEM, judgeUser);
  const judgeStop = record(ctx, n, 'test', 'judge', j.verdict,
    j.verdict === 'pass' ? j.reason : [j.reason, ...j.reasons.slice(1)].join('; '),
    { prompt: { system: JUDGE_SYSTEM, user: judgeUser }, answer: j.raw ?? null, reasons: j.reasons }, 'test judge');
  if (judgeStop) return stopped(judgeStop);

  const sha256 = createHash('sha256').update(source).digest('hex');
  ctx.log.write({ issue: n, step: 'test', check: 'lock', reason: `sha256 ${sha256}`, evidence: { path, sha256, source } });

  await fetchBranchBack(ctx.repoDir, dir, branch);
  const pushed = await ctx.gh.push(n, ctx.repoDir, ['origin', `${branch}:refs/heads/${branch}`]);
  if (!pushed.ok) {
    const stop = record(ctx, n, 'test', 'push', 'unknown', pushed.reason, {}, 'push branch');
    return stopped(stop!);
  }

  return {
    ok: true,
    value: { R, path, source, sha256, branchPushed: !ctx.gh.dryRun, checksReason: checks.reason, judgeReason: j.reason },
  };
}
