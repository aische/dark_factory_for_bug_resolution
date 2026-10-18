import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { run } from './exec.js';

export type Outcome = 'passed' | 'failure' | 'error' | 'skipped';

export interface TestCase {
  name: string;
  classname: string;
  outcome: Outcome;
  failureText: string;
}

export interface PytestResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cases: TestCase[];
}

export interface PytestOptions {
  cwd: string;
  venvDir: string;
  junitPath: string;
  timeoutSec: number;
  /** Test paths; empty runs the configured testpaths. */
  args?: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

type Node = string | { '#text'?: string; message?: string } | undefined;

function text(node: Node | Node[]): string {
  const n = Array.isArray(node) ? node[0] : node;
  if (n === undefined) return '';
  if (typeof n === 'string') return n;
  return n['#text'] ?? n.message ?? '';
}

export function parseJunit(xml: string): TestCase[] {
  const doc = parser.parse(xml);
  const suites: any[] = doc.testsuites?.testsuite ?? doc.testsuite ?? [];
  const cases: TestCase[] = [];
  for (const suite of suites) {
    for (const tc of suite.testcase ?? []) {
      const outcome: Outcome =
        tc.error !== undefined ? 'error'
        : tc.failure !== undefined ? 'failure'
        : tc.skipped !== undefined ? 'skipped'
        : 'passed';
      const failureText =
        outcome === 'failure' ? text(tc.failure) : outcome === 'error' ? text(tc.error) : '';
      cases.push({ name: tc.name ?? '', classname: tc.classname ?? '', outcome, failureText });
    }
  }
  return cases;
}

/** Run `<venv>/bin/python -m pytest` with a JUnit report (C-WS-3). */
export async function runPytest(opts: PytestOptions): Promise<PytestResult> {
  mkdirSync(dirname(opts.junitPath), { recursive: true });
  const bin = join(opts.venvDir, 'bin');
  const r = await run(
    join(bin, 'python'),
    ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${opts.junitPath}`, ...(opts.args ?? [])],
    {
      cwd: opts.cwd,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, PYTHONDONTWRITEBYTECODE: '1', VIRTUAL_ENV: opts.venvDir },
      timeoutMs: opts.timeoutSec * 1000,
    },
  );
  let cases: TestCase[] = [];
  if (!r.timedOut && existsSync(opts.junitPath)) {
    try {
      cases = parseJunit(readFileSync(opts.junitPath, 'utf8'));
    } catch {
      cases = [];
    }
  }
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, cases };
}

export function summarize(r: PytestResult): Record<string, unknown> {
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    cases: r.cases.map((c) => ({ name: c.name, outcome: c.outcome })),
    output: r.stdout + r.stderr,
  };
}
