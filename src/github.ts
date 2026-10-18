import { describe, run, runOk } from './exec.js';
import { FactoryError } from './errors.js';
import type { EvidenceLog } from './log.js';

export const LABELS = {
  factory: 'factory',
  inProgress: 'factory:in-progress',
  resolved: 'factory:resolved',
  needsHuman: 'factory:needs-human',
} as const;

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  createdAt: string;
}

export type PushResult = { ok: true } | { ok: false; rejected: boolean; reason: string };

/** gh and git-push wrappers. Every write is logged; in dry run writes are printed, not made. */
export class GitHub {
  constructor(
    readonly repo: string,
    readonly dryRun: boolean,
    private readonly log: EvidenceLog,
  ) {}

  url(path = ''): string {
    return `https://github.com/${this.repo}${path}`;
  }

  async listOpenFactoryIssues(): Promise<GhIssue[]> {
    const out = await runOk('gh', [
      'issue', 'list', '--repo', this.repo, '--label', LABELS.factory, '--state', 'open',
      '--json', 'number,title,body,labels,createdAt', '--limit', '200',
    ]);
    const issues = JSON.parse(out) as GhIssue[];
    return issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async ensureLabels(): Promise<void> {
    for (const name of Object.values(LABELS)) {
      await this.write(undefined, 'label', ['label', 'create', name, '--force', '--repo', this.repo]);
    }
  }

  addLabel(issue: number, label: string): Promise<void> {
    return this.write(issue, 'label', ['issue', 'edit', String(issue), '--repo', this.repo, '--add-label', label]);
  }

  removeLabel(issue: number, label: string): Promise<void> {
    return this.write(issue, 'label', ['issue', 'edit', String(issue), '--repo', this.repo, '--remove-label', label]);
  }

  comment(issue: number, body: string): Promise<void> {
    return this.write(issue, 'comment', ['issue', 'comment', String(issue), '--repo', this.repo, '--body-file', '-'], body);
  }

  close(issue: number): Promise<void> {
    return this.write(issue, 'close', ['issue', 'close', String(issue), '--repo', this.repo, '--reason', 'completed']);
  }

  deleteBranch(issue: number, branch: string): Promise<void> {
    return this.write(issue, 'delete-branch', ['api', '-X', 'DELETE', `repos/${this.repo}/git/refs/heads/${branch}`]);
  }

  /** git push from the run's repo/ clone to GitHub. A rejection is returned, other failures throw. */
  async push(issue: number, repoDir: string, args: string[]): Promise<PushResult> {
    const cmd = `git push ${args.join(' ')}`;
    if (this.dryRun) {
      this.log.write({ issue, step: 'github', check: 'push', reason: `dry run: ${cmd}`, evidence: { args, dryRun: true } });
      return { ok: true };
    }
    const r = await run('git', ['push', '--porcelain', ...args], { cwd: repoDir });
    const output = r.stdout + r.stderr;
    if (r.exitCode === 0) {
      this.log.write({ issue, step: 'github', check: 'push', reason: cmd, evidence: { args, output } });
      return { ok: true };
    }
    if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/.test(output)) {
      this.log.write({ issue, step: 'github', check: 'push', reason: `rejected: ${cmd}`, evidence: { args, output } });
      return { ok: false, rejected: true, reason: `push rejected: ${cmd}` };
    }
    throw new FactoryError(`${cmd} failed: ${describe(r)}`);
  }

  private async write(issue: number | undefined, check: string, args: string[], body?: string): Promise<void> {
    const cmd = `gh ${args.join(' ')}`;
    const evidence: Record<string, unknown> = { args, ...(body === undefined ? {} : { body }) };
    if (this.dryRun) {
      this.log.write({ issue, step: 'github', check, reason: `dry run: ${cmd}`, evidence: { ...evidence, dryRun: true } });
      if (body !== undefined) this.log.say(body.replace(/^/gm, '    | '));
      return;
    }
    const r = await run('gh', args, { input: body });
    if (r.exitCode !== 0) throw new FactoryError(`${cmd} failed: ${describe(r)}`);
    this.log.write({ issue, step: 'github', check, reason: cmd, evidence });
  }
}
