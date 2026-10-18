import { z } from 'zod';
import { record, stopped, type RunContext, type StepResult } from '../context.js';
import { lsFiles } from '../git.js';
import type { GhIssue } from '../github.js';
import { formatReport, isScalar, parseReport, type BugReport, type Scalar } from '../report.js';

const TRIAGE_SYSTEM =
  'You decide whether a bug report describes a trivial bug: a wrong value returned by the code, with a concrete input, expected value and actual value, that a small change in one source file can fix. Answer JSON {"trivial": boolean, "reason": string}.';

const EXTRACT_SYSTEM =
  'You normalize a free-form GitHub bug issue into a structured report the factory can act on. '
  + 'Extract a component name, a short description, a concrete JSON input object (argument values only, scalars), '
  + 'and concrete expected and actual scalar results. '
  + 'expected is the correct return value; actual is what the buggy code returns today for that input. '
  + 'If the issue does not describe a concrete wrong value you can pin down, set extractable to false. '
  + 'Answer JSON {"extractable": boolean, "reason": string, "component"?: string, "description"?: string, '
  + '"input"?: object, "expected"?: number|string|boolean|null, "actual"?: number|string|boolean|null}.';

const TriageSchema = z.object({ trivial: z.boolean(), reason: z.string() });

const ScalarSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const ExtractSchema = z.object({
  extractable: z.boolean(),
  reason: z.string(),
  component: z.string().optional(),
  description: z.string().optional(),
  input: z.record(z.string(), ScalarSchema).optional(),
  expected: ScalarSchema.optional(),
  actual: ScalarSchema.optional(),
});

export interface Found {
  report: BugReport;
}

function validateExtracted(
  number: number,
  title: string,
  raw: z.infer<typeof ExtractSchema>,
): { ok: true; report: BugReport } | { ok: false; reason: string } {
  if (!raw.extractable) return { ok: false, reason: raw.reason || 'not extractable' };
  if (!raw.component?.trim()) return { ok: false, reason: 'extracted report missing component' };
  if (!raw.description?.trim()) return { ok: false, reason: 'extracted report missing description' };
  if (!raw.input || typeof raw.input !== 'object') return { ok: false, reason: 'extracted input is not an object' };
  const bad = Object.entries(raw.input).find(([, v]) => !isScalar(v));
  if (bad) return { ok: false, reason: `extracted input value "${bad[0]}" is not a scalar` };
  if (!isScalar(raw.expected as Scalar)) return { ok: false, reason: 'extracted expected is not a scalar' };
  if (!isScalar(raw.actual as Scalar)) return { ok: false, reason: 'extracted actual is not a scalar' };
  if (raw.expected === raw.actual) return { ok: false, reason: 'extracted Expected equals Actual' };
  return {
    ok: true,
    report: {
      number,
      title,
      component: raw.component.trim(),
      description: raw.description.trim(),
      input: raw.input as Record<string, Scalar>,
      expected: raw.expected as Scalar,
      actual: raw.actual as Scalar,
    },
  };
}

/** Form checks (or LLM extract) and LLM triage (C-FIND-2, C-FIND-3). Never skips an issue. */
export async function findStep(ctx: RunContext, issue: GhIssue): Promise<StepResult<Found>> {
  const n = issue.number;
  const files = await lsFiles(ctx.repoDir);
  let report: BugReport | null = null;
  let formSource: 'form' | 'extract' = 'form';

  const parsed = parseReport(n, issue.title, issue.body);
  if (parsed.ok) {
    report = parsed.report;
    const form = record(ctx, n, 'find', 'form', 'pass', 'all fields present and concrete', {
      body: issue.body, report, source: 'form',
    }, 'form checks');
    if (form) return stopped(form);
  } else {
    ctx.log.write({
      issue: n, step: 'find', check: 'form', verdict: 'fail',
      reason: parsed.reason,
      evidence: { body: issue.body, report: null, source: 'form' },
    });

    const extractUser = [
      `Issue: #${n}`,
      `Title: ${issue.title}`,
      `Body:\n${issue.body}`,
      `Files in the repository:\n${files.join('\n')}`,
    ].join('\n\n');
    const extracted = await ctx.llm.completeJson(ExtractSchema, EXTRACT_SYSTEM, extractUser);
    if (!extracted.ok) {
      const stop = record(ctx, n, 'find', 'extract', 'unknown', extracted.reason, {
        prompt: { system: EXTRACT_SYSTEM, user: extractUser },
        answer: extracted.raw ?? null,
        formReason: parsed.reason,
      }, 'extract report');
      return stopped(stop!);
    }

    const validated = validateExtracted(n, issue.title, extracted.value);
    const stop = record(
      ctx, n, 'find', 'extract',
      validated.ok ? 'pass' : 'fail',
      validated.ok ? `extracted: ${validated.report.component}` : validated.reason,
      {
        prompt: { system: EXTRACT_SYSTEM, user: extractUser },
        answer: extracted.raw,
        report: validated.ok ? validated.report : null,
        formReason: parsed.reason,
        modelReason: extracted.value.reason,
      },
      'extract report',
    );
    if (stop || !validated.ok) return stopped(stop!);
    report = validated.report;
    formSource = 'extract';
  }

  const denylist = ctx.policy.triage.componentDenylist.map((c) => c.toLowerCase());
  if (denylist.includes(report.component.toLowerCase())) {
    const stop = record(
      ctx, n, 'find', 'form', 'fail',
      `component ${report.component} is on the denylist`,
      { body: issue.body, report, source: formSource },
      'form checks',
    );
    return stopped(stop!);
  }

  const user = `${formatReport(report)}\n\nFiles in the repository:\n${files.join('\n')}`;
  const res = await ctx.llm.completeJson(TriageSchema, TRIAGE_SYSTEM, user);
  const verdict = !res.ok ? 'unknown' : res.value.trivial ? 'pass' : 'fail';
  const triageReason = !res.ok ? res.reason : `${res.value.trivial ? 'trivial' : 'not trivial'}: ${res.value.reason}`;
  const triage = record(ctx, n, 'find', 'triage', verdict, triageReason, {
    prompt: { system: TRIAGE_SYSTEM, user },
    answer: res.raw ?? null,
    source: formSource,
  });
  if (triage) return stopped(triage);
  return { ok: true, value: { report } };
}
