export type Scalar = number | string | boolean | null;

export interface BugReport {
  number: number;
  title: string;
  component: string;
  description: string;
  input: Record<string, Scalar>;
  expected: Scalar;
  actual: Scalar;
}

export type ParseResult = { ok: true; report: BugReport } | { ok: false; reason: string };

const FIELDS = ['Component', 'Description', 'Input', 'Expected', 'Actual'] as const;
const NO_RESPONSE = '_No response_';

/** Split a rendered issue form into `### <Label>` sections, keyed by lower-case label. */
export function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, lines.join('\n').trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1]!.toLowerCase();
      lines = [];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/** Textareas with `render: json` come wrapped in a code fence. */
function unfence(value: string): string {
  const m = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(value.trim());
  return (m ? m[1]! : value).trim();
}

export function isScalar(v: unknown): v is Scalar {
  return v === null || ['number', 'string', 'boolean'].includes(typeof v);
}

function parseJsonField(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(unfence(value)) };
  } catch {
    return { ok: false };
  }
}

/** Form checks (C-FIND-2), except the component denylist, which needs the policy. */
export function parseReport(number: number, title: string, body: string): ParseResult {
  const sections = parseSections(body ?? '');
  const fields: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const name of FIELDS) {
    const value = sections.get(name.toLowerCase());
    if (value === undefined || value === '') return { ok: false, reason: `field ${name} is missing` };
    if (value === NO_RESPONSE) return { ok: false, reason: `field ${name} has no response` };
    fields[name] = value;
  }

  const input = parseJsonField(fields.Input!);
  if (!input.ok) return { ok: false, reason: 'Input is not JSON' };
  const obj = input.value;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: 'Input is not a JSON object' };
  }
  const bad = Object.entries(obj).find(([, v]) => !isScalar(v));
  if (bad) return { ok: false, reason: `Input value "${bad[0]}" is not a scalar` };

  const scalars: Scalar[] = [];
  for (const name of ['Expected', 'Actual'] as const) {
    const parsed = parseJsonField(fields[name]!);
    if (!parsed.ok || !isScalar(parsed.value)) {
      return { ok: false, reason: `${name} is not a JSON scalar (strings must be quoted)` };
    }
    scalars.push(parsed.value);
  }
  const [expected, actual] = scalars as [Scalar, Scalar];
  if (expected === actual) return { ok: false, reason: 'Expected equals Actual' };

  return {
    ok: true,
    report: {
      number,
      title,
      component: fields.Component!,
      description: fields.Description!,
      input: obj as Record<string, Scalar>,
      expected,
      actual,
    },
  };
}

export function formatReport(r: BugReport): string {
  return [
    `Issue: #${r.number}`,
    `Title: ${r.title}`,
    `Component: ${r.component}`,
    `Description: ${r.description}`,
    `Input: ${JSON.stringify(r.input)}`,
    `Expected: ${JSON.stringify(r.expected)}`,
    `Actual: ${JSON.stringify(r.actual)}`,
  ].join('\n');
}
