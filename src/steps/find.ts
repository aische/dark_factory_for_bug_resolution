import { z } from 'zod';
import { record, stopped, type RunContext, type StepResult } from '../context.js';
import { lsFiles } from '../git.js';
import type { GhIssue } from '../github.js';
import { formatReport, parseReport, type BugReport } from '../report.js';

const TRIAGE_SYSTEM =
  'You decide whether a bug report describes a trivial bug: a wrong value returned by the code, with a concrete input, expected value and actual value, that a small change in one source file can fix. Answer JSON {"trivial": boolean, "reason": string}.';

const TriageSchema = z.object({ trivial: z.boolean(), reason: z.string() });

export interface Found {
  report: BugReport;
}

/** Form checks and LLM triage (C-FIND-2, C-FIND-3). */
export async function findStep(ctx: RunContext, issue: GhIssue): Promise<StepResult<Found>> {
  const n = issue.number;
  const parsed = parseReport(n, issue.title, issue.body);
  let reason = parsed.ok ? 'all fields present and concrete' : parsed.reason;
  const denylist = ctx.policy.triage.componentDenylist.map((c) => c.toLowerCase());
  if (parsed.ok && denylist.includes(parsed.report.component.toLowerCase())) {
    reason = `component ${parsed.report.component} is on the denylist`;
  }
  const formOk = parsed.ok && reason === 'all fields present and concrete';
  const form = record(ctx, n, 'find', 'form', formOk ? 'pass' : 'fail', reason, {
    body: issue.body,
    report: parsed.ok ? parsed.report : null,
  }, 'form checks');
  if (form || !parsed.ok) return stopped(form!);
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
