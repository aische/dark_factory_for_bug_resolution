import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Policy } from './config.js';
import { UsageError } from './errors.js';
import { run, runOk } from './exec.js';
import { assertLines, containsLiteral, errorLines, expectationLines, formatLiteral } from './literals.js';
import type { Scalar } from './report.js';
import { runWithJunit, summarize, type SuiteResult } from './suite.js';

export type Language = 'python' | 'typescript';

export interface RuntimeSetup {
  /** Shared environment root: venv for Python, the main repo clone for TypeScript. */
  envDir: string;
  reason: string;
  evidence: Record<string, unknown>;
}

export interface RunTestsOpts {
  cwd: string;
  envDir: string;
  junitPath: string;
  timeoutSec: number;
  /** Specific test paths; empty runs the full suite. */
  args?: string[];
}

export interface TargetRuntime {
  language: Language;
  setup(repoDir: string, runDir: string, policy: Policy): Promise<RuntimeSetup>;
  /** Make a working copy able to run tests (e.g. symlink node_modules). */
  prepareCheckout(envDir: string, cwd: string): void;
  runTests(opts: RunTestsOpts): Promise<SuiteResult>;
  testCommand(envDir: string, cwd: string, testPath: string): string;
  pathPrefix(envDir: string, cwd: string): string;
  reproPath(dir: string, issue: number): string;
  extractCodeBlock(text: string): string | null;
  generateSystem: string;
  generateRules(issue: number, path: string): string[];
  exampleTest(repoDir: string, files: string[], reproDir: string): { path: string; source: string } | null;
  isAssertionFailure(failureText: string): boolean;
  /** Text used to look for the reported actual value. */
  failureSearchText(failureText: string): string;
  sourceProblem(
    source: string,
    input: Record<string, Scalar>,
    expected: Scalar,
    actual: Scalar,
    failureSearch: string,
  ): string | null;
  formatLiteral(v: Scalar): string;
}

const EXAMPLE_CAP = 10 * 1024;

function firstFence(text: string, lang: string): string | null {
  const m = new RegExp('```' + lang + '[^\\n]*\\n([\\s\\S]*?)```').exec(text);
  return m ? m[1]!.replace(/\s*$/, '\n') : null;
}

function readExample(repoDir: string, path: string): { path: string; source: string } {
  return { path, source: readFileSync(join(repoDir, path), 'utf8').slice(0, EXAMPLE_CAP) };
}

const pythonRuntime: TargetRuntime = {
  language: 'python',

  async setup(repoDir, runDir, policy) {
    const envDir = join(runDir, 'venv');
    const python = join(envDir, 'bin', 'python');
    await runOk(policy.tests.python, ['-m', 'venv', envDir]);
    const reqs = ['requirements.txt', 'requirements-dev.txt'].filter((f) => existsSync(join(repoDir, f)));
    for (const f of reqs) {
      await runOk(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', f], { cwd: repoDir });
    }
    if ((await run(python, ['-c', 'import pytest'])).exitCode !== 0) {
      await runOk(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'pytest']);
    }
    return {
      envDir,
      reason: `python venv with ${reqs.join(', ') || 'pytest only'}`,
      evidence: { envDir, language: 'python', requirements: reqs },
    };
  },

  prepareCheckout() {},

  runTests(opts) {
    const bin = join(opts.envDir, 'bin');
    return runWithJunit(
      join(bin, 'python'),
      ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${opts.junitPath}`, ...(opts.args ?? [])],
      {
        cwd: opts.cwd,
        junitPath: opts.junitPath,
        timeoutSec: opts.timeoutSec,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, PYTHONDONTWRITEBYTECODE: '1', VIRTUAL_ENV: opts.envDir },
      },
    );
  },

  testCommand(envDir, _cwd, testPath) {
    return `${join(envDir, 'bin', 'python')} -m pytest ${testPath} -q`;
  },

  pathPrefix(envDir) {
    return join(envDir, 'bin');
  },

  reproPath(dir, issue) {
    return `${dir}/test_issue_${issue}.py`;
  },

  extractCodeBlock: (text) => firstFence(text, 'python'),

  generateSystem:
    'You write exactly one pytest test that reproduces a bug report. Answer with one ```python code block and nothing else.',

  generateRules(issue, path) {
    return [
      `- One test function named test_issue_${issue}, saved as ${path}.`,
      '- Import the code under test the way the example test does.',
      "- Call the code with the report's input values, written as literals.",
      '- The `assert` line compares the result with the expected value written as a literal, for example `assert result == 0.00` or `assert result == pytest.approx(11.96)`.',
      '- No mocks of the code under test, no network, no files, no sleeps, no skips.',
      '- The test must fail on the current code with an assertion error and pass once the bug is fixed.',
    ];
  },

  exampleTest(repoDir, files, reproDir) {
    const repro = reproDir.replace(/\/?$/, '/');
    const candidates = files.filter((f) => f.startsWith('tests/') && !f.startsWith(repro) && f.endsWith('.py'));
    const path = candidates.find((f) => /(^|\/)test_[^/]*\.py$/.test(f)) ?? candidates[0];
    return path ? readExample(repoDir, path) : null;
  },

  isAssertionFailure(failureText) {
    const first = errorLines(failureText)[0];
    return !!first && /^E\s+(assert\b|AssertionError\b)/.test(first);
  },

  failureSearchText(failureText) {
    return errorLines(failureText).join('\n');
  },

  sourceProblem(source, input, expected, actual, failureSearch) {
    const missing = Object.entries(input).find(([, v]) => !containsLiteral(source, v, 'python'));
    if (missing) return `input ${missing[0]}=${formatLiteral(missing[1], 'python')} is not a literal in the test`;
    if (!containsLiteral(assertLines(source), expected, 'python')) {
      return `expected ${formatLiteral(expected, 'python')} is not on an assert line`;
    }
    if (!containsLiteral(failureSearch, actual, 'python')) {
      return `actual ${formatLiteral(actual, 'python')} is not in the failure output`;
    }
    if (!/\bdef test_/.test(source)) return 'no test function';
    if (/pytest\.mark\.skip|pytest\.mark\.xfail|pytest\.skip\(/.test(source)) return 'test skips or xfails';
    return null;
  },

  formatLiteral: (v) => formatLiteral(v, 'python'),
};

const typescriptRuntime: TargetRuntime = {
  language: 'typescript',

  async setup(repoDir) {
    const hasLock = existsSync(join(repoDir, 'package-lock.json'));
    const install = hasLock
      ? await run('npm', ['ci', '--no-fund', '--no-audit'], { cwd: repoDir })
      : { exitCode: 1, stdout: '', stderr: '', timedOut: false };
    if (install.exitCode !== 0) {
      await runOk('npm', ['install', '--no-fund', '--no-audit'], { cwd: repoDir });
    }
    if (!existsSync(join(repoDir, 'node_modules', 'vitest', 'package.json'))) {
      throw new UsageError('typescript target needs vitest in package.json dependencies (or devDependencies)');
    }
    return {
      envDir: repoDir,
      reason: hasLock && install.exitCode === 0 ? 'npm ci (vitest)' : 'npm install (vitest)',
      evidence: { envDir: repoDir, language: 'typescript', installer: hasLock ? 'npm ci' : 'npm install' },
    };
  },

  prepareCheckout(envDir, cwd) {
    if (envDir === cwd) return;
    const src = join(envDir, 'node_modules');
    const dest = join(cwd, 'node_modules');
    if (!existsSync(src) || existsSync(dest)) return;
    symlinkSync(src, dest, 'dir');
  },

  runTests(opts) {
    const local = join(opts.cwd, 'node_modules', '.bin', 'vitest');
    const shared = join(opts.envDir, 'node_modules', '.bin', 'vitest');
    const cmd = existsSync(local) ? local : shared;
    return runWithJunit(
      cmd,
      [
        'run',
        '--reporter=default',
        '--reporter=junit',
        `--outputFile.junit=${opts.junitPath}`,
        ...(opts.args ?? []),
      ],
      {
        cwd: opts.cwd,
        junitPath: opts.junitPath,
        timeoutSec: opts.timeoutSec,
        env: {
          PATH: `${join(opts.cwd, 'node_modules', '.bin')}:${join(opts.envDir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
          NODE_ENV: 'test',
        },
      },
    );
  },

  testCommand(_envDir, cwd, testPath) {
    const vitest = join(cwd, 'node_modules', '.bin', 'vitest');
    return `${existsSync(vitest) ? vitest : 'npx vitest'} run ${testPath}`;
  },

  pathPrefix(envDir, cwd) {
    return [join(cwd, 'node_modules', '.bin'), join(envDir, 'node_modules', '.bin')].join(':');
  },

  reproPath(dir, issue) {
    return `${dir}/issue_${issue}.test.ts`;
  },

  extractCodeBlock: (text) => firstFence(text, 'typescript') ?? firstFence(text, 'ts') ?? firstFence(text, 'javascript'),

  generateSystem:
    'You write exactly one Vitest test that reproduces a bug report. Answer with one ```typescript code block and nothing else.',

  generateRules(issue, path) {
    return [
      `- One test, saved as ${path}. Prefer it("reproduces issue ${issue}: …", …) or test("…", …).`,
      '- Import the code under test the way the example test does (same relative path style).',
      "- Call the code with the report's input values, written as literals.",
      '- Use expect(result).toBe(expected) (or toEqual) with the expected value as a literal.',
      '- No mocks of the code under test, no network, no files, no sleeps, no skips (.skip / xit).',
      '- The test must fail on the current code with an assertion error and pass once the bug is fixed.',
    ];
  },

  exampleTest(repoDir, files, reproDir) {
    const repro = reproDir.replace(/\/?$/, '/');
    const candidates = files.filter((f) =>
      !f.startsWith(repro) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
    const path = candidates.find((f) => f.startsWith('tests/'))
      ?? candidates.find((f) => f.startsWith('src/'))
      ?? candidates[0];
    return path ? readExample(repoDir, path) : null;
  },

  isAssertionFailure(failureText) {
    return /AssertionError\b|expected[\s\S]{0,300}\bto (?:be|equal|strictly equal)\b/i.test(failureText);
  },

  failureSearchText(failureText) {
    return failureText;
  },

  sourceProblem(source, input, expected, actual, failureSearch) {
    const missing = Object.entries(input).find(([, v]) => !containsLiteral(source, v, 'js'));
    if (missing) return `input ${missing[0]}=${formatLiteral(missing[1], 'js')} is not a literal in the test`;
    if (!containsLiteral(expectationLines(source), expected, 'js')) {
      return `expected ${formatLiteral(expected, 'js')} is not on an expectation line`;
    }
    if (!containsLiteral(failureSearch, actual, 'js')) {
      return `actual ${formatLiteral(actual, 'js')} is not in the failure output`;
    }
    if (!/\b(?:it|test)\s*\(/.test(source)) return 'no test() or it() call';
    if (/\b(?:it|test|describe)\.skip\b|\bxit\s*\(|\bxdescribe\s*\(/.test(source)) return 'test skips';
    return null;
  },

  formatLiteral: (v) => formatLiteral(v, 'js'),
};

export function detectLanguage(repoDir: string): Language {
  const pkgPath = join(repoDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest || deps.typescript || deps.jest || deps['@types/node']) return 'typescript';
    } catch {
      /* fall through */
    }
    if (!existsSync(join(repoDir, 'requirements.txt')) && !existsSync(join(repoDir, 'pyproject.toml'))) {
      return 'typescript';
    }
  }
  return 'python';
}

export function resolveRuntime(policy: Policy, repoDir: string): TargetRuntime {
  const configured = policy.tests.language;
  const language = configured === 'auto' ? detectLanguage(repoDir) : configured;
  if (language === 'typescript') return typescriptRuntime;
  if (language === 'python') return pythonRuntime;
  throw new UsageError(`unknown tests.language "${String(language)}"`);
}

export { summarize };
export type { SuiteResult };
