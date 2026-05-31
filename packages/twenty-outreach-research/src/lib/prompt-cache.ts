// Assembles the cached system prompt that every L2/L3 call shares.
// The prompt is structured so the Anthropic cache control breakpoint sits
// AFTER all the static content (core + style guide + rubric), so we get a
// hot cache hit on every subsequent target.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '../../prompts');

const read = (name: string): string => readFileSync(join(promptsDir, name), 'utf-8');

export const CORE_CONTEXT = read('system-core.md');
export const STYLE_GUIDE = read('style-guide.md');
export const RUBRIC = read('rubric.md');

export const SYSTEM_PROMPT_FOR_RESEARCH = [
  CORE_CONTEXT,
  '---',
  STYLE_GUIDE,
].join('\n\n');

export const SYSTEM_PROMPT_FOR_DRAFTING = [
  CORE_CONTEXT,
  '---',
  STYLE_GUIDE,
  '---',
  '## Self-critique rubric (apply after drafting)',
  RUBRIC,
].join('\n\n');

export const SYSTEM_PROMPT_FOR_JUDGING = [
  CORE_CONTEXT,
  '---',
  STYLE_GUIDE,
  '---',
  '## Rubric (apply when scoring drafts)',
  RUBRIC,
  '',
  'You are an independent judge. The drafter does not see your reasoning. Score honestly. If you would not personally hit Send on this email to a Yale roboticist peer, the salesBotSmell or hookPlausibility score should reflect that.',
].join('\n\n');
