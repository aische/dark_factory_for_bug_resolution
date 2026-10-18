import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  branchName, issueDir, record, stopped, type RunContext, type StepResult,
} from '../context.js';
import { clone, gitOk, head } from '../git.js';
import { describe, run } from '../exec.js';
import { FactoryError } from '../errors.js';
import type { BugReport } from '../report.js';
import type { LockedTest } from './test.js';

export interface FixerDiff {
  patch: string;
  patchPath: string;
}

export function fixerPrompt(r: BugReport, testPath: string, testCommand: string): string {
  return `Fix bug #${r.number} in this repository.

Title: ${r.title}
Component: ${r.component}
Description: ${r.description}
Input: ${JSON.stringify(r.input)}
Expected: ${JSON.stringify(r.expected)}
Actual: ${JSON.stringify(r.actual)}

A test that reproduces the bug is at ${testPath}. It fails now and must pass after your fix.
Run it with: ${testCommand}

Rules:
- Change only files under src/. Do not add, change, rename or delete tests, test configuration, config files or dependencies.
- Make the smallest change that fixes the root cause. Do not special-case the test's input values.
- Do not add imports.
- Do not commit. Leave your changes in the working tree.
- If the bug cannot be fixed within these rules, stop without changing anything.
`;
}

/** Run the fixer on a clone of the branch and take its diff against R (C-FIX-3). */
export async function fixStep(ctx: RunContext, r: BugReport, test: LockedTest): Promise<StepResult<FixerDiff>> {
  const n = r.number;
  const dir = issueDir(ctx, n);
  const ws = join(dir, 'fixer');
  await clone(ctx.repoDir, ws, branchName(n));
  if ((await head(ws)) !== test.R) throw new FactoryError(`fixer workspace is not at ${test.R}`);

  ctx.runtime.prepareCheckout(ctx.envDir, ws);
  const testCommand = ctx.runtime.testCommand(ctx.envDir, ws, test.path);
  const prompt = fixerPrompt(r, test.path, testCommand);
  const provider = ctx.fixerProvider;
  const timeoutSec = ctx.policy.fixer.timeoutSec;
  const launch = ctx.fixer.launch({ workspace: ws, issue: r, prompt, testPath: test.path, testCommand, provider, timeoutSec });

  // Only what the fixer needs; never GitHub tokens or other providers' keys (R-FIX-7).
  const env: Record<string, string> = {
    PATH: `${ctx.runtime.pathPrefix(ctx.envDir, ws)}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: 'dumb',
    ...launch.env,
  };
  ctx.log.write({
    issue: n, step: 'fix', check: 'launch',
    reason: `${ctx.fixer.name} (${provider.name}/${provider.model})`,
    evidence: { cmd: launch.cmd, args: launch.args.map((a) => (a === provider.apiKey ? '<api key>' : a)), envKeys: Object.keys(env), prompt },
  });

  const started = Date.now();
  const res = await run(launch.cmd, launch.args, { cwd: ws, env, extendEnv: false, timeoutMs: timeoutSec * 1000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(dir, 'fixer.log'), `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`);

  await gitOk(ws, ['add', '-A']);
  const patch = await gitOk(ws, ['diff', '--cached', '--binary', test.R]);
  const patchPath = join(dir, 'fixer.diff');
  writeFileSync(patchPath, patch);

  let verdict: 'pass' | 'unknown' = 'pass';
  let reason = `diff of ${patch.split('\n').length} lines after ${seconds}s`;
  if (res.timedOut) [verdict, reason] = ['unknown', `fixer timed out after ${timeoutSec}s`];
  else if (res.exitCode !== 0) [verdict, reason] = ['unknown', `fixer failed: ${describe(res)}`];
  else if (!patch.trim()) [verdict, reason] = ['unknown', 'fixer made no change'];
  const stop = record(ctx, n, 'fix', 'run', verdict, reason, {
    exitCode: res.exitCode, seconds, output: res.stdout + res.stderr, diff: patch,
  }, 'run fixer');
  if (stop) return stopped(stop);
  return { ok: true, value: { patch, patchPath } };
}
