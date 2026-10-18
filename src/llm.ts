import OpenAI from 'openai';
import { z } from 'zod';
import type { ResolvedProvider } from './config.js';
import type { Verdict } from './log.js';

export type Completion = { ok: true; text: string } | { ok: false; error: string };
export type JsonAnswer<T> = { ok: true; value: T; raw: string } | { ok: false; reason: string; raw?: string };

/** OpenAI-compatible chat client. Nothing here branches on the provider name (C-CFG-2). */
export class Llm {
  private readonly client: OpenAI;

  constructor(
    readonly provider: ResolvedProvider,
    private readonly temperature: number,
    timeoutSec: number,
  ) {
    this.client = new OpenAI({
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      timeout: timeoutSec * 1000,
      maxRetries: 1,
    });
  }

  async complete(system: string, user: string, json = false): Promise<Completion> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.provider.model,
        temperature: this.temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(json && this.provider.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      });
      const text = res.choices[0]?.message?.content;
      if (!text) return { ok: false, error: 'empty answer' };
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: `LLM API error: ${(err as Error).message}` };
    }
  }

  async completeJson<T>(schema: z.ZodType<T>, system: string, user: string): Promise<JsonAnswer<T>> {
    const res = await this.complete(system, user, true);
    if (!res.ok) return { ok: false, reason: res.error };
    const value = parseJson(res.text);
    if (value === undefined) return { ok: false, reason: 'answer is not JSON', raw: res.text };
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, reason: `answer does not match the schema: ${parsed.error.issues[0]?.message}`, raw: res.text };
    }
    return { ok: true, value: parsed.data, raw: res.text };
  }
}

/** Parse a JSON object from an answer that may carry reasoning or a code fence around it. */
export function parseJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(cleaned)?.[1];
  for (const candidate of [cleaned, fenced, cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

export const JudgeSchema = z.object({
  verdict: z.enum(['good', 'bad']),
  reasons: z.array(z.string()),
});

export interface Judgement {
  verdict: Verdict;
  reason: string;
  reasons: string[];
  raw?: string;
}

/** `good` passes, `bad` fails, anything unparseable is unknown. */
export async function judge(llm: Llm, system: string, user: string): Promise<Judgement> {
  const res = await llm.completeJson(JudgeSchema, system, user);
  if (!res.ok) return { verdict: 'unknown', reason: res.reason, reasons: [], raw: res.raw };
  const { verdict, reasons } = res.value;
  return {
    verdict: verdict === 'good' ? 'pass' : 'fail',
    reason: `${verdict}: ${reasons[0] ?? 'no reason given'}`,
    reasons,
    raw: res.raw,
  };
}
