import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { UsageError } from './errors.js';

const ProviderSchema = z.object({
  baseURL: z.string().min(1),
  anthropicBaseURL: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1),
  model: z.string().min(1),
  // Request response_format json_object. Turn off for models that reject it.
  jsonMode: z.boolean().default(true),
});

const compiles = (pattern: string) => {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
};

export const PolicySchema = z.object({
  llm: z.object({
    provider: z.string().min(1),
    providers: z.record(z.string(), ProviderSchema),
    timeoutSec: z.number().positive(),
    temperature: z.number().min(0),
  }),
  fixer: z.object({
    name: z.string().min(1),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    timeoutSec: z.number().positive(),
  }),
  triage: z.object({ componentDenylist: z.array(z.string()) }),
  test: z.object({ dir: z.string().min(1), runs: z.number().int().positive() }),
  diff: z.object({
    allowedPaths: z.array(z.string()),
    protectedPaths: z.array(z.string()),
    maxFiles: z.number().int().positive(),
    maxChangedLines: z.number().int().positive(),
    maxHunks: z.number().int().positive(),
    secretPatterns: z.array(
      z.string().refine(compiles, { message: 'does not compile as a JavaScript regex' }),
    ),
  }),
  tests: z.object({
    /** Target language. `auto` picks typescript when package.json looks like a JS/TS app, else python. */
    language: z.enum(['auto', 'python', 'typescript']).default('auto'),
    python: z.string().min(1).default('python3'),
    timeoutSec: z.number().positive(),
  }),
  git: z.object({ authorName: z.string().min(1), authorEmail: z.string().min(1) }),
});

export type Policy = z.infer<typeof PolicySchema>;
export type DiffPolicy = Policy['diff'];

export interface ResolvedProvider {
  name: string;
  baseURL: string;
  anthropicBaseURL?: string;
  apiKeyEnv: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
}

export interface LoadedPolicy {
  policy: Policy;
  sha256: string;
}

export function loadPolicy(path: string): LoadedPolicy {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read policy ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`policy ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new UsageError(`policy ${path} is invalid:\n  ${issues.join('\n  ')}`);
  }
  return { policy: parsed.data, sha256: createHash('sha256').update(raw).digest('hex') };
}

export function resolveProvider(
  policy: Policy,
  name: string,
  model?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const p = policy.llm.providers[name];
  if (!p) {
    const known = Object.keys(policy.llm.providers).join(', ');
    throw new UsageError(`unknown provider "${name}" (policy has: ${known})`);
  }
  const apiKey = env[p.apiKeyEnv];
  if (!apiKey) throw new UsageError(`${p.apiKeyEnv} is not set (needed for provider ${name})`);
  return {
    name,
    baseURL: p.baseURL,
    anthropicBaseURL: p.anthropicBaseURL,
    apiKeyEnv: p.apiKeyEnv,
    apiKey,
    model: model ?? p.model,
    jsonMode: p.jsonMode,
  };
}

export function normaliseRepo(input: string): string {
  const m =
    /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) throw new UsageError(`--repo must be owner/name or a GitHub URL, got "${input}"`);
  return `${m[1]}/${m[2]}`;
}
