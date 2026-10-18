import type { ResolvedProvider } from '../config.js';
import type { BugReport } from '../report.js';
import { claude } from './claude.js';
import { omp } from './omp.js';
import { rogueEditTest } from './rogue.js';

export interface FixerInput {
  /** Clone of the branch, HEAD at the test commit R. */
  workspace: string;
  issue: BugReport;
  prompt: string;
  /** The repro test, relative to the workspace. */
  testPath: string;
  testCommand: string;
  provider: ResolvedProvider;
  timeoutSec: number;
}

export interface FixerLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export interface Fixer {
  name: string;
  supports(provider: string): boolean;
  launch(input: FixerInput): FixerLaunch;
}

const registry = new Map<string, Fixer>([omp, claude, rogueEditTest].map((f) => [f.name, f]));

export const getFixer = (name: string): Fixer | undefined => registry.get(name);
export const fixerNames = (): string[] => [...registry.keys()];
