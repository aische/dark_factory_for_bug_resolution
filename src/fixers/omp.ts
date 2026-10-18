import { fileURLToPath } from 'node:url';
import type { Fixer } from './index.js';

// fixers/ at the factory root, from src/fixers/ or dist/fixers/.
const overlay = fileURLToPath(new URL('../../fixers/omp-nebius.yml', import.meta.url));

export const omp: Fixer = {
  name: 'omp',
  supports: (provider) => provider === 'deepseek' || provider === 'nebius',
  launch: ({ workspace, prompt, provider, timeoutSec }) => ({
    cmd: 'omp',
    args: [
      '-p',
      '--cwd', workspace,
      ...(provider.name === 'nebius' ? ['--config', overlay] : []),
      '--model', `${provider.name}/${provider.model}`,
      '--api-key', provider.apiKey,
      '--auto-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--max-time', String(timeoutSec),
      prompt,
    ],
    env: {},
  }),
};
