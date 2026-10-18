import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, runOk, type RunResult } from './exec.js';
import { FactoryError } from './errors.js';

export interface Identity {
  authorName: string;
  authorEmail: string;
}

const EXCLUDES = ['.omp/', '.claude/', '__pycache__/', '.pytest_cache/', '*.pyc', 'node_modules/'];

export const git = (cwd: string, args: string[]): Promise<RunResult> => run('git', args, { cwd });
export const gitOk = (cwd: string, args: string[]): Promise<string> => runOk('git', args, { cwd });

function asIdentity(id: Identity): string[] {
  return [
    '-c', `user.name=${id.authorName}`,
    '-c', `user.email=${id.authorEmail}`,
    '-c', 'commit.gpgsign=false',
  ];
}

/** Fresh clone with local excludes (C-WS-1, C-WS-2). */
export async function clone(src: string, dest: string, branch?: string): Promise<void> {
  const args = ['clone', '--quiet', ...(branch ? ['--branch', branch] : []), src, dest];
  await runOk('git', args);
  addExcludes(dest);
}

export function addExcludes(cwd: string): void {
  appendFileSync(join(cwd, '.git', 'info', 'exclude'), '\n' + EXCLUDES.join('\n') + '\n');
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function head(cwd: string): Promise<string> {
  const sha = await revParse(cwd, 'HEAD');
  if (!sha) throw new FactoryError(`no HEAD in ${cwd}`);
  return sha;
}

/** origin/HEAD, falling back to main, then master. */
export async function defaultBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.exitCode === 0) return r.stdout.trim().replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (await revParse(cwd, `origin/${name}`)) return name;
  }
  throw new FactoryError('cannot find the default branch (origin/HEAD, main, master)');
}

export async function lsFiles(cwd: string): Promise<string[]> {
  const out = await gitOk(cwd, ['ls-files']);
  return out.split('\n').filter(Boolean);
}

/** Stage everything and commit. Returns the new HEAD sha. */
export async function commitAll(cwd: string, message: string, id: Identity): Promise<string> {
  await gitOk(cwd, ['add', '-A']);
  await gitOk(cwd, [...asIdentity(id), 'commit', '--quiet', '--no-verify', '-m', message]);
  return head(cwd);
}

/** Rebase the current branch onto `onto`. On a conflict the rebase is aborted and false returned. */
export async function rebase(cwd: string, onto: string, id: Identity): Promise<boolean> {
  const r = await git(cwd, [...asIdentity(id), 'rebase', '--quiet', onto]);
  if (r.exitCode === 0) return true;
  await git(cwd, ['rebase', '--abort']);
  return false;
}

/** Copy a branch from a working copy into the run's repo/ clone, ready to push. */
export async function fetchBranchBack(repoDir: string, workDir: string, branch: string): Promise<void> {
  await gitOk(repoDir, ['fetch', '--quiet', workDir, `+${branch}:${branch}`]);
}
