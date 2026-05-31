import { callJson } from '../lib/llm-router.js';
import type { ResearchBrief, HookCandidate } from '../research/brief-schema.js';
import { TwoVariantOutputSchema, type TwoVariantOutput } from './draft-schema.js';

const formatBrief = (brief: ResearchBrief): string => {
  return [
    `Target: ${brief.targetName} (${brief.targetAffiliation})`,
    `Type: ${brief.targetType}`,
    `Recommended register: ${brief.recommendedRegister}`,
    `Best-fit service: ${brief.bestFitVerletService}`,
    `One-line: ${brief.oneLineSummary}`,
    '',
    `Hook candidates (ranked):`,
    ...brief.hookCandidates.map(
      (h, i) =>
        `  ${i + 1}. [${h.source} · spec=${h.specificity}/5 · ${h.freshness}] ${h.claim}\n     cite: ${h.citation}`,
    ),
    '',
    `Technical profile:`,
    `  focus: ${brief.technicalProfile.focus}`,
    `  stack: ${brief.technicalProfile.stack.join(', ')}`,
    `  pain: ${brief.technicalProfile.knownPainPoints.join('; ')}`,
    '',
    `Mutual connections: ${brief.mutualConnections.join(', ') || 'none'}`,
  ].join('\n');
};

export const selectBestHook = (brief: ResearchBrief): HookCandidate => {
  // Deterministic pick — highest specificity, freshest tiebreaker.
  const order: Record<string, number> = {
    '<30d': 5,
    '30-90d': 4,
    '90-365d': 3,
    evergreen: 2,
    '>1y': 1,
  };
  return [...brief.hookCandidates].sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    return (order[b.freshness] ?? 0) - (order[a.freshness] ?? 0);
  })[0];
};

export const writeTwoVariants = async (
  brief: ResearchBrief,
  hook: HookCandidate,
): Promise<TwoVariantOutput> => {
  const prompt = [
    `# Research brief`,
    formatBrief(brief),
    '',
    `# Chosen hook for the opening line`,
    `${hook.claim} (source: ${hook.source}, citation: ${hook.citation})`,
    '',
    `# Your task`,
    `Produce two email draft variants per the style guide:`,
    `- shortVariant: ~120 words. One personalization beat in first 25 words referencing the chosen hook. Three sentences of value prop max. One CTA. Subject ≤6 words.`,
    `- longVariant: ~200 words. Same opening, two extra sentences of technical specificity on the best-fit Verlet service (${brief.bestFitVerletService}). Same CTA.`,
    '',
    `Sign as Mateo Sanchez for academic targets; Charlie Humphreys for commercial targets unless the brief suggests Mateo has a stronger Yale/research peer angle.`,
    `Always include the sample data link "data.verlet.co" with code "verlet-demo-2026".`,
    `For commercial targets, include the pricing/pilot link from the playbook; for academic targets, omit unless commercial signals were strong.`,
    '',
    `Apply the rubric to your own output before returning. Do not return drafts that would score below 4/5 on specificity or salesBotSmell.`,
  ].join('\n');

  return callJson('writer', prompt, TwoVariantOutputSchema);
};
