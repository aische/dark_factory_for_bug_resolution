import { execa, type Options } from 'execa';
import { FactoryError } from './errors.js';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** false: the child sees only `env`. */
  extendEnv?: boolean;
  timeoutMs?: number;
  input?: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started or was killed by a signal. */
  error?: string;
}

// Process groups still running, killed if the factory exits early.
const live = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

process.on('exit', () => live.forEach(killGroup));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    live.forEach(killGroup);
    process.exit(1);
  });
}

/**
 * Run a command in its own process group. Never throws for a non-zero exit;
 * on timeout the whole group is killed.
 */
export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const options: Options = {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: opts.extendEnv ?? true,
    reject: false,
    detached: true,
    stripFinalNewline: false,
    maxBuffer: 256 * 1024 * 1024,
    ...(opts.input === undefined ? { stdin: 'ignore' } : { input: opts.input }),
  };
  const sub = execa(cmd, args, options);
  const pid = sub.pid;
  if (pid !== undefined) live.add(pid);
  let timedOut = false;
  const timer =
    opts.timeoutMs && pid !== undefined
      ? setTimeout(() => {
          timedOut = true;
          killGroup(pid);
        }, opts.timeoutMs)
      : undefined;
  try {
    const r = await sub;
    return {
      exitCode: r.exitCode ?? null,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      timedOut,
      error: r.exitCode === undefined ? r.shortMessage : undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (pid !== undefined) live.delete(pid);
  }
}

export function describe(r: RunResult): string {
  if (r.timedOut) return 'timed out';
  if (r.error) return r.error;
  const tail = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-5).join('\n');
  return `exit ${r.exitCode}${tail ? `: ${tail}` : ''}`;
}

/** Like run, but a failure is a FactoryError. Returns stdout. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.exitCode !== 0 || r.timedOut) {
    throw new FactoryError(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${describe(r)}`);
  }
  return r.stdout;
}
