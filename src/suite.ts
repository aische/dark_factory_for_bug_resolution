import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { run, type RunResult } from './exec.js';

export type Outcome = 'passed' | 'failure' | 'error' | 'skipped';

export interface TestCase {
  name: string;
  classname: string;
  outcome: Outcome;
  failureText: string;
}

export interface SuiteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cases: TestCase[];
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

export function readJunit(junitPath: string): TestCase[] {
  if (!existsSync(junitPath)) return [];
  try {
    return parseJunit(readFileSync(junitPath, 'utf8'));
  } catch {
    return [];
  }
}

/** Run a test command that writes JUnit XML to junitPath. */
export async function runWithJunit(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; junitPath: string; timeoutSec: number },
): Promise<SuiteResult> {
  mkdirSync(dirname(opts.junitPath), { recursive: true });
  const r: RunResult = await run(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutSec * 1000,
  });
  const cases = r.timedOut ? [] : readJunit(opts.junitPath);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, cases };
}

export function summarize(r: SuiteResult): Record<string, unknown> {
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    cases: r.cases.map((c) => ({ name: c.name, outcome: c.outcome })),
    output: r.stdout + r.stderr,
  };
}
