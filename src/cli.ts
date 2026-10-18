#!/usr/bin/env -S node --env-file-if-exists=.env
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { loadPolicy, normaliseRepo, resolveProvider } from './config.js';
import type { RunContext, Stop } from './context.js';
import { FactoryError, UsageError } from './errors.js';
import { run, runOk } from './exec.js';
import { fixerNames, getFixer } from './fixers/index.js';
import { addExcludes, defaultBranch, gitOk, revParse } from './git.js';
import { GitHub, LABELS, type GhIssue } from './github.js';
import { Llm } from './llm.js';
import { EvidenceLog } from './log.js';
import { resolveRuntime, summarize } from './runtime.js';
import { findStep } from './steps/find.js';
import { fixStep } from './steps/fix.js';
import { handToHuman, mergeStep, resolveIssue } from './steps/merge.js';
import { postStep } from './steps/post.js';
import { testStep } from './steps/test.js';

interface RunOptions {
  repo: string;
  sha?: string;
  fixer?: string;
  provider?: string;
  issue?: number;
  dryRun?: boolean;
  jsonl?: boolean;
  policy: string;
}

function newRunId(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString('hex')}`;
}

let activeLog: EvidenceLog | null = null;

/** C-RUN-1: config, clone, base sha, venv, suite green on base. */
async function setup(opts: RunOptions): Promise<RunContext> {
  const { policy, sha256 } = loadPolicy(opts.policy);
  if (opts.provider) policy.llm.provider = opts.provider;
  if (opts.fixer) policy.fixer.name = opts.fixer;

  const fixer = getFixer(policy.fixer.name);
  if (!fixer) throw new UsageError(`unknown fixer "${policy.fixer.name}" (known: ${fixerNames().join(', ')})`);
  const llmProvider = resolveProvider(policy, policy.llm.provider);
  const fixerProvider = resolveProvider(policy, policy.fixer.provider ?? policy.llm.provider, policy.fixer.model);
  if (!fixer.supports(fixerProvider.name)) {
    throw new UsageError(`fixer ${fixer.name} does not support provider ${fixerProvider.name}`);
  }
  const secrets = [llmProvider, fixerProvider]
    .filter((p, i, all) => all.findIndex((q) => q.apiKeyEnv === p.apiKeyEnv) === i)
    .map((p) => ({ env: p.apiKeyEnv, value: p.apiKey }));
  const repo = normaliseRepo(opts.repo);

  const runId = newRunId();
  const runDir = resolve('.factory', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const log = new EvidenceLog(join(runDir, 'log.jsonl'), { runId, repo, policySha256: sha256 }, !!opts.jsonl);
  activeLog = log;
  const gh = new GitHub(repo, !!opts.dryRun, log);

  const auth = await run('gh', ['auth', 'status']);
  if (auth.exitCode !== 0) throw new FactoryError(`gh is not installed or not logged in: ${auth.error ?? auth.stderr.trim()}`);

  const repoDir = join(runDir, 'repo');
  await runOk('git', ['clone', '--quiet', `https://github.com/${repo}.git`, repoDir]);
  addExcludes(repoDir);
  const branch = await defaultBranch(repoDir);
  const baseSha = opts.sha ? await revParse(repoDir, opts.sha) : await revParse(repoDir, `origin/${branch}`);
  if (!baseSha) throw new UsageError(`unknown sha ${opts.sha ?? `origin/${branch}`} in ${repo}`);
  await gitOk(repoDir, ['checkout', '--quiet', '--detach', baseSha]);
  log.baseSha = baseSha;
  const runtime = resolveRuntime(policy, repoDir);
  log.write({
    step: 'setup',
    reason: `${repo} base ${baseSha.slice(0, 7)} on ${branch}, language ${runtime.language}, fixer ${fixer.name} (${fixerProvider.name}/${fixerProvider.model}), llm ${llmProvider.name}/${llmProvider.model}`,
    evidence: {
      runDir, baseSha, defaultBranch: branch, language: runtime.language, fixer: fixer.name,
      fixerProvider: fixerProvider.name, fixerModel: fixerProvider.model,
      llmProvider: llmProvider.name, llmModel: llmProvider.model, dryRun: !!opts.dryRun,
    },
  });

  const installed = await runtime.setup(repoDir, runDir, policy);
  log.write({
    step: 'setup', check: 'env',
    reason: `${runtime.language}: ${installed.reason}`,
    evidence: installed.evidence,
  });

  const suite = await runtime.runTests({
    cwd: repoDir,
    envDir: installed.envDir,
    junitPath: join(runDir, 'junit', 'base-suite.xml'),
    timeoutSec: policy.tests.timeoutSec,
  });
  const green = suite.exitCode === 0 && !suite.timedOut && suite.cases.length > 0;
  log.write({
    step: 'setup', check: 'suite', verdict: green ? 'pass' : 'fail',
    reason: green ? `${suite.cases.length} tests green on base` : 'suite is not green on base',
    evidence: summarize(suite),
  });
  if (!green) throw new FactoryError('suite is not green on base; not touching any issue');

  return {
    runId, runDir, repoDir, envDir: installed.envDir, runtime, repo, baseSha, defaultBranch: branch, policy,
    llm: new Llm(llmProvider, policy.llm.temperature, policy.llm.timeoutSec),
    fixer, fixerProvider, secrets, log, gh,
  };
}

type IssueOutcome =
  | { merged: true; issue: number; commitUrl: string }
  | { merged: false; issue: number; stop: Stop }
  | { skipped: true; issue: number; reason: string };

/** Steps 2–6 for one issue. Escalations are handled here; factory errors propagate. */
async function processIssue(ctx: RunContext, issue: GhIssue): Promise<IssueOutcome> {
  const n = issue.number;
  await ctx.gh.addLabel(n, LABELS.inProgress);
  let labelled = true;
  let branchPushed = false;
  const toHuman = async (stop: Stop): Promise<IssueOutcome> => {
    await handToHuman(ctx, n, stop, branchPushed);
    labelled = false;
    return { merged: false, issue: n, stop };
  };
  try {
    const found = await findStep(ctx, issue);
    if ('skip' in found) {
      ctx.log.write({
        issue: n, step: 'find', check: 'skip',
        reason: `not a factory bug report: ${found.reason}`,
        evidence: { reason: found.reason },
      });
      return { skipped: true, issue: n, reason: found.reason };
    }
    if (!found.ok) return await toHuman(found.stop);
    const report = found.value.report;

    const test = await testStep(ctx, report);
    if (!test.ok) return await toHuman(test.stop);
    branchPushed = test.value.branchPushed;

    const fix = await fixStep(ctx, report, test.value);
    if (!fix.ok) return await toHuman(fix.stop);

    const post = await postStep(ctx, report, test.value, fix.value);
    if (!post.ok) return await toHuman(post.stop);

    const merged = await mergeStep(ctx, report, test.value, post.value);
    if (!merged.ok) return await toHuman(merged.stop);

    await resolveIssue(ctx, report, merged.value, {
      testChecks: test.value.checksReason,
      testJudge: test.value.judgeReason,
      diffChecks: merged.value.diffReason,
      tests: merged.value.testsReason,
      fixJudge: post.value.judgeReason,
    });
    labelled = false;
    return { merged: true, issue: n, commitUrl: ctx.gh.url(`/commit/${merged.value.fixSha}`) };
  } finally {
    if (labelled) await ctx.gh.removeLabel(n, LABELS.inProgress).catch(() => undefined);
  }
}

async function runFactory(opts: RunOptions): Promise<number> {
  const ctx = await setup(opts);
  const skip = new Set<string>([LABELS.inProgress, LABELS.resolved, LABELS.needsHuman]);
  const open = await ctx.gh.listOpenIssues();
  const candidates = open
    .filter((i) => !i.labels.some((l) => skip.has(l.name)))
    .filter((i) => opts.issue === undefined || i.number === opts.issue);
  ctx.log.write({
    step: 'find', check: 'candidates',
    reason: `${candidates.length} of ${open.length} open issues to process`,
    evidence: { open: open.map((i) => i.number), candidates: candidates.map((i) => i.number) },
  });

  // Labels are only created once there is work, so a run with nothing to do never writes to GitHub.
  if (candidates.length > 0) await ctx.gh.ensureLabels();

  const toHuman: Extract<IssueOutcome, { merged: false }>[] = [];
  let skipped = 0;
  for (const issue of candidates) {
    const outcome = await processIssue(ctx, issue);
    if ('skipped' in outcome) {
      skipped++;
      continue;
    }
    if (outcome.merged) {
      ctx.log.write({
        step: 'run', reason: `merged #${outcome.issue}`,
        evidence: {
          merged: { issue: outcome.issue, commitUrl: outcome.commitUrl },
          needsHuman: toHuman.map(summaryOf),
          skipped,
        },
      });
      ctx.log.say(`\nMerged #${outcome.issue}: ${outcome.commitUrl}`);
      printHanded(ctx, toHuman);
      return 0;
    }
    toHuman.push(outcome);
  }
  const tried = candidates.length - skipped;
  ctx.log.write({
    step: 'run',
    reason: !candidates.length ? 'no open issues to process'
      : !tried ? 'no structured bug reports among open issues'
      : 'nothing merged; all structured issues went to a human',
    evidence: { merged: null, needsHuman: toHuman.map(summaryOf), skipped },
  });
  ctx.log.say(
    !candidates.length ? '\nNo open issues to process.'
      : !tried ? '\nNo structured bug reports among open issues.'
      : '\nNothing merged.',
  );
  printHanded(ctx, toHuman);
  return 3;
}

const summaryOf = (o: Extract<IssueOutcome, { merged: false }>) => ({
  issue: o.issue, step: o.stop.label, verdict: o.stop.verdict, reason: o.stop.reason,
});

function printHanded(ctx: RunContext, handed: Extract<IssueOutcome, { merged: false }>[]): void {
  if (handed.length === 0) return;
  ctx.log.say('Handed to a human:');
  for (const o of handed) ctx.log.say(`  #${o.issue}  ${o.stop.label}  ${o.stop.verdict}  ${o.stop.reason}`);
}

function parseIssue(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('must be an issue number');
  return n;
}

async function main(): Promise<number> {
  let code = 0;
  const program = new Command('factory').description('Dark factory for trivial bug resolution').exitOverride();
  program
    .command('run')
    .description('Find the first trivial factory issue, fix it on a branch and merge it')
    .requiredOption('--repo <repo>', 'owner/name or GitHub URL')
    .option('--sha <sha>', 'base commit (default: head of the default branch)')
    .option('--fixer <name>', `override the policy fixer (${fixerNames().join(', ')})`)
    .option('--provider <name>', 'override the policy LLM provider')
    .option('--issue <number>', 'process only this issue', parseIssue)
    .option('--dry-run', 'no GitHub writes and no pushes; print them instead')
    .option('--jsonl', 'print log entries as JSON lines')
    .option('--policy <path>', 'policy file', 'factory.policy.json')
    .action(async (opts: RunOptions) => {
      code = await runFactory(opts);
    });

  try {
    await program.parseAsync(process.argv);
    return code;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
    const exitCode = err instanceof UsageError || err instanceof FactoryError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    if (activeLog) {
      try {
        activeLog.write({ step: 'run', verdict: 'fail', reason: `factory error: ${message}`, evidence: { exitCode } });
      } catch {
        // the log itself failed; report on stderr only
      }
    }
    process.stderr.write(`factory: ${message}\n`);
    if (exitCode === 1 && !(err instanceof FactoryError) && err instanceof Error) process.stderr.write(`${err.stack}\n`);
    return exitCode;
  }
}

process.exitCode = await main();
