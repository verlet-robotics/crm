import { callJson } from '../lib/llm-router.js';
import type { ResearchBrief, HookCandidate } from '../research/brief-schema.js';
import {
  CritiqueOutputSchema,
  type CritiqueOutput,
  type TwoVariantOutput,
} from './draft-schema.js';

export const selfCritique = async (
  brief: ResearchBrief,
  hook: HookCandidate,
  drafts: TwoVariantOutput,
): Promise<CritiqueOutput> => {
  const prompt = [
    `# Drafts to critique`,
    `## Short variant`,
    `Subject: ${drafts.shortVariant.subject}`,
    drafts.shortVariant.body,
    '',
    `## Long variant`,
    `Subject: ${drafts.longVariant.subject}`,
    drafts.longVariant.body,
    '',
    `# Target context`,
    `${brief.targetName} (${brief.targetAffiliation}) — type=${brief.targetType}, register=${brief.recommendedRegister}.`,
    `Hook used: ${hook.claim} (${hook.source}, ${hook.citation})`,
    '',
    `# Your task`,
    `Score each variant against the rubric. If shortScore.rewriteNeeded is true, return a fully rewritten shortRewrite that fixes the issues. Same for long.`,
    `A variant needs rewrite if total < 18 OR any single dimension is ≤ 2.`,
    `Do not be charitable. If you would not personally send this to a Yale roboticist peer, the salesBotSmell score should reflect that and the rewrite should fix it.`,
  ].join('\n');

  return callJson('critic', prompt, CritiqueOutputSchema);
};
