import type { Fixer } from './index.js';

// Nebius has no Anthropic-compatible endpoint.
export const claude: Fixer = {
  name: 'claude',
  supports: (provider) => provider === 'deepseek',
  launch: ({ prompt, provider }) => ({
    cmd: 'claude',
    args: ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--max-turns', '40', prompt],
    env: {
      ANTHROPIC_BASE_URL: provider.anthropicBaseURL ?? '',
      ANTHROPIC_AUTH_TOKEN: provider.apiKey,
      ANTHROPIC_MODEL: provider.model,
      ANTHROPIC_SMALL_FAST_MODEL: provider.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  }),
};
