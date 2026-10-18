import { join } from 'node:path';
import type { Policy, ResolvedProvider } from './config.js';
import type { Fixer } from './fixers/index.js';
import type { GitHub } from './github.js';
import type { Llm } from './llm.js';
import type { EvidenceLog, Verdict } from './log.js';
import type { TargetRuntime } from './runtime.js';

export interface RunContext {
  runId: string;
  runDir: string;
  /** Clone of the GitHub repo; the only place pushes go from. */
  repoDir: string;
  /** Shared test environment: Python venv, or the main clone (with node_modules) for TypeScript. */
  envDir: string;
  runtime: TargetRuntime;
  repo: string;
  baseSha: string;
  defaultBranch: string;
  policy: Policy;
  llm: Llm;
  fixer: Fixer;
  fixerProvider: ResolvedProvider;
  /** API keys the factory loaded, for the secret check. */
  secrets: { env: string; value: string }[];
  log: EvidenceLog;
  gh: GitHub;
}

export type Step = 'find' | 'test' | 'fix' | 'post' | 'merge';

const STEP_NAMES: Record<Step, string> = {
  find: 'find',
  test: 'test',
  fix: 'fixer',
  post: 'post-check',
  merge: 'merge',
};

/** Why an issue went to a human. */
export interface Stop {
  step: Step;
  check: string;
  /** For the comment, e.g. "post-check · protected paths". */
  label: string;
  verdict: 'fail' | 'unknown';
  reason: string;
}

export type StepResult<T> = { ok: true; value: T } | { ok: false; stop: Stop };

export const stopped = (stop: Stop): { ok: false; stop: Stop } => ({ ok: false, stop });

/** Log a check; return a Stop unless it passed. */
export function record(
  ctx: RunContext,
  issue: number,
  step: Step,
  check: string,
  verdict: Verdict,
  reason: string,
  evidence: Record<string, unknown> = {},
  detail: string = check,
): Stop | undefined {
  ctx.log.write({ issue, step, check, verdict, reason, evidence });
  if (verdict === 'pass') return undefined;
  return { step, check, label: `${STEP_NAMES[step]} · ${detail}`, verdict, reason };
}

export const branchName = (n: number) => `factory/issue-${n}`;
export const issueDir = (ctx: RunContext, n: number) => join(ctx.runDir, `issue-${n}`);
export const testPath = (ctx: RunContext, n: number) => ctx.runtime.reproPath(ctx.policy.test.dir, n);
