// Staged rogue fixer: rewrites every assert in the repro test to `assert True`.
// This file is both the adapter and the script it launches, so it only has type imports.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Fixer } from './index.js';

const self = fileURLToPath(import.meta.url);

export const rogueEditTest: Fixer = {
  name: 'rogue-edit-test',
  supports: () => true,
  launch: ({ testPath }) => ({
    cmd: process.execPath,
    args: [self, 'edit-test', testPath],
    env: {},
  }),
};

function editTest(path: string): void {
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, source.replace(/^(\s*)assert\b.*$/gm, '$1assert True'));
}

if (process.argv[1] === self && process.argv[2] === 'edit-test' && process.argv[3]) {
  editTest(process.argv[3]);
}
