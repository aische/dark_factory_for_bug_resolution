import { appendFileSync } from 'node:fs';
import { FactoryError } from './errors.js';

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface LogInput {
  issue?: number;
  step: string;
  check?: string;
  verdict?: Verdict;
  reason?: string;
  evidence?: Record<string, unknown>;
}

const MAX_STRING = 20 * 1024;

/** Keep the last 20 KB of long strings; full output stays in files under issue-<n>/. */
export function cut(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING) return value;
    return `[cut ${value.length - MAX_STRING} chars]…` + value.slice(-MAX_STRING);
  }
  if (Array.isArray(value)) return value.map(cut);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]));
  }
  return value;
}

/** JSONL evidence log (C-LOG-1). Every entry is written synchronously; a failed write is fatal. */
export class EvidenceLog {
  baseSha: string | null = null;

  constructor(
    readonly path: string,
    private readonly ctx: { runId: string; repo: string; policySha256: string },
    readonly jsonl: boolean,
  ) {}

  write(input: LogInput): void {
    const entry = {
      ts: new Date().toISOString(),
      runId: this.ctx.runId,
      repo: this.ctx.repo,
      baseSha: this.baseSha,
      issue: input.issue ?? null,
      step: input.step,
      check: input.check ?? null,
      verdict: input.verdict ?? null,
      reason: input.reason ?? null,
      evidence: cut(input.evidence ?? {}),
      policySha256: this.ctx.policySha256,
    };
    const line = JSON.stringify(entry) + '\n';
    try {
      appendFileSync(this.path, line);
    } catch (err) {
      throw new FactoryError(`cannot write evidence log ${this.path}: ${(err as Error).message}`);
    }
    if (this.jsonl) {
      process.stdout.write(line);
    } else {
      const issue = input.issue === undefined ? '' : `#${input.issue}`;
      const name = input.check ? `${input.step}.${input.check}` : input.step;
      const cols = [issue.padEnd(5), name.padEnd(16)];
      if (input.verdict) cols.push(input.verdict.toUpperCase().padEnd(7));
      if (input.reason) cols.push(input.reason);
      process.stdout.write(cols.join(' ').trimEnd() + '\n');
    }
  }

  /** Free text for a human. Kept off stdout in --jsonl mode so stdout carries only events. */
  say(text: string): void {
    (this.jsonl ? process.stderr : process.stdout).write(text + '\n');
  }
}
