import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  branchName, issueDir, record, stopped, type RunContext, type StepResult, type Stop,
} from '../context.js';
import { fetchBranchBack, gitOk, rebase, revParse } from '../git.js';
import { LABELS } from '../github.js';
import type { BugReport } from '../report.js';
import { diffChecksIn, testsIn, type Verified } from './post.js';
import type { LockedTest } from './test.js';

export interface Merged {
  testSha: string;
  fixSha: string;
  diffReason: string;
  testsReason: string;
}

/** Fast-forward the default branch to the issue branch, rebasing and re-checking if it moved (C-MRG-1). */
export async function mergeStep(
  ctx: RunContext, r: BugReport, test: LockedTest, verified: Verified,
): Promise<StepResult<Merged>> {
  const n = r.number;
  const branch = branchName(n);
  const target = ctx.defaultBranch;
  let base = ctx.baseSha;
  let { diffReason, testsReason } = verified;

  for (let attempt = 1; attempt <= 2; attempt++) {
    await gitOk(ctx.repoDir, ['fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`]);
    const remoteHead = await revParse(ctx.repoDir, `refs/remotes/origin/${target}`);
    if (!remoteHead) return stopped(record(ctx, n, 'merge', 'fetch', 'unknown', `${target} not found on origin`)!);

    if (remoteHead !== base) {
      ctx.log.write({ issue: n, step: 'merge', check: 'moved', reason: `${target} moved to ${remoteHead.slice(0, 7)}, rebasing` });
      const dir = verified.dir;
      await gitOk(dir, ['fetch', '--quiet', 'origin', `+refs/remotes/origin/${target}:refs/factory/${target}`]);
      if (!(await rebase(dir, `refs/factory/${target}`, ctx.policy.git))) {
        return stopped(record(ctx, n, 'merge', 'rebase', 'fail', `rebase onto ${target} ${remoteHead.slice(0, 7)} conflicts`)!);
      }
      const patch = await gitOk(dir, ['diff', '--binary', 'HEAD~1', 'HEAD']);
      const patchPath = join(issueDir(ctx, n), `rebased-${attempt}.diff`);
      writeFileSync(patchPath, patch);
      const diff = await diffChecksIn(ctx, n, 'merge', dir, patchPath, test);
      if (diff.stop) return stopped(diff.stop);
      const tests = await testsIn(ctx, n, 'merge', dir, test, `merge-${attempt}`);
      if (tests.stop) return stopped(tests.stop);
      [diffReason, testsReason] = [diff.reason, tests.reason];

      await fetchBranchBack(ctx.repoDir, dir, branch);
      const forced = await ctx.gh.push(n, ctx.repoDir, ['--force', 'origin', `${branch}:refs/heads/${branch}`]);
      if (!forced.ok) return stopped(record(ctx, n, 'merge', 'push', 'unknown', forced.reason, {}, 'push branch')!);
      base = remoteHead;
    }

    // Fast-forward only: never force-push the default branch.
    const pushed = await ctx.gh.push(n, ctx.repoDir, ['origin', `${branch}:refs/heads/${target}`]);
    if (pushed.ok) {
      const fixSha = (await revParse(ctx.repoDir, branch))!;
      const testSha = (await revParse(ctx.repoDir, `${branch}~1`))!;
      record(ctx, n, 'merge', 'push', 'pass', `merged to ${target} at ${fixSha.slice(0, 7)}`, { testSha, fixSha, attempt });
      return { ok: true, value: { testSha, fixSha, diffReason, testsReason } };
    }
  }
  return stopped(record(ctx, n, 'merge', 'push', 'unknown', `push to ${target} rejected twice`, {}, `push to ${target}`)!);
}

export interface ResolvedRows {
  testChecks: string;
  testJudge: string;
  diffChecks: string;
  tests: string;
  fixJudge: string;
}

/** Comment, label resolved, close and delete the branch (C-MRG-2). */
export async function resolveIssue(ctx: RunContext, r: BugReport, merged: Merged, rows: ResolvedRows): Promise<void> {
  const n = r.number;
  const fp = ctx.fixerProvider;
  const commit = (sha: string) => ctx.gh.url(`/commit/${sha}`);
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const body = `Fixed by the dark factory and merged to ${ctx.defaultBranch}.

Commits: ${commit(merged.testSha)}, ${commit(merged.fixSha)}
Run: ${ctx.runId} · base ${ctx.baseSha.slice(0, 7)} · fixer ${ctx.fixer.name} (${fp.name}/${fp.model})

| Check | Result |
|---|---|
| triage | trivial |
| test checks | ${cell(rows.testChecks)} |
| test judge | ${cell(rows.testJudge)} |
| diff checks | ${cell(rows.diffChecks)} |
| tests after fix | ${cell(rows.tests)} |
| fix judge | ${cell(rows.fixJudge)} |
`;
  await ctx.gh.comment(n, body);
  await ctx.gh.addLabel(n, LABELS.resolved);
  await ctx.gh.removeLabel(n, LABELS.inProgress);
  await ctx.gh.close(n);
  await ctx.gh.deleteBranch(n, branchName(n));
}

/** Comment for a human and leave the issue open (C-HUM-1). */
export async function handToHuman(ctx: RunContext, n: number, stop: Stop, branchPushed: boolean): Promise<void> {
  const lines = [
    'The dark factory needs a human for this issue.',
    '',
    `Step: ${stop.label}`,
    `Result: ${stop.verdict}`,
    `Reason: ${stop.reason}`,
    ...(branchPushed ? [`Branch: ${ctx.gh.url(`/tree/${branchName(n)}`)}`] : []),
    `Run: ${ctx.runId} · base ${ctx.baseSha.slice(0, 7)}`,
  ];
  await ctx.gh.comment(n, lines.join('\n') + '\n');
  await ctx.gh.addLabel(n, LABELS.needsHuman);
  await ctx.gh.removeLabel(n, LABELS.inProgress);
}
