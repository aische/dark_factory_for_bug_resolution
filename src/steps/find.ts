import { z } from 'zod';
import { record, stopped, type RunContext, type StepResult, type Stop } from '../context.js';
import { lsFiles } from '../git.js';
import type { GhIssue } from '../github.js';
import { formatReport, parseReport, type BugReport } from '../report.js';

const TRIAGE_SYSTEM =
  'You decide whether a bug report describes a trivial bug: a wrong value returned by the code, with a concrete input, expected value and actual value, that a small change in one source file can fix. Answer JSON {"trivial": boolean, "reason": string}.';

const TriageSchema = z.object({ trivial: z.boolean(), reason: z.string() });

export interface Found {
  report: BugReport;
}

export type FindResult =
  | StepResult<Found>
  /** Body is not a structured bug report — not a candidate; do not escalate. */
  | { ok: false; skip: true; reason: string };

/** Form checks and LLM triage (C-FIND-2, C-FIND-3). */
export async function findStep(ctx: RunContext, issue: GhIssue): Promise<FindResult> {
  const n = issue.number;
  const parsed = parseReport(n, issue.title, issue.body);
  if (!parsed.ok) {
    ctx.log.write({
      issue: n, step: 'find', check: 'form', verdict: 'fail',
      reason: parsed.reason,
      evidence: { body: issue.body, report: null, skip: true },
    });
    return { ok: false, skip: true, reason: parsed.reason };
  }

  const denylist = ctx.policy.triage.componentDenylist.map((c) => c.toLowerCase());
  if (denylist.includes(parsed.report.component.toLowerCase())) {
    const stop = record(
      ctx, n, 'find', 'form', 'fail',
      `component ${parsed.report.component} is on the denylist`,
      { body: issue.body, report: parsed.report },
      'form checks',
    );
    return stopped(stop!);
  }

  const form = record(ctx, n, 'find', 'form', 'pass', 'all fields present and concrete', {
    body: issue.body,
    report: parsed.report,
  }, 'form checks');
  if (form) return stopped(form);
  const report = parsed.report;

  const files = await lsFiles(ctx.repoDir);
  const user = `${formatReport(report)}\n\nFiles in the repository:\n${files.join('\n')}`;
  const res = await ctx.llm.completeJson(TriageSchema, TRIAGE_SYSTEM, user);
  const verdict = !res.ok ? 'unknown' : res.value.trivial ? 'pass' : 'fail';
  const triageReason = !res.ok ? res.reason : `${res.value.trivial ? 'trivial' : 'not trivial'}: ${res.value.reason}`;
  const triage = record(ctx, n, 'find', 'triage', verdict, triageReason, {
    prompt: { system: TRIAGE_SYSTEM, user },
    answer: res.raw ?? null,
  });
  if (triage) return stopped(triage);
  return { ok: true, value: { report } };
}

export type { Stop };
