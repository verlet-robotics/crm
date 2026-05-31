import { callJson } from '../lib/llm-router.js';
import { JudgeScoreSchema, type EmailDraft, type JudgeScore } from './draft-schema.js';
import type { ResearchBrief, HookCandidate } from '../research/brief-schema.js';

export const judgeDraft = async (
  brief: ResearchBrief,
  hook: HookCandidate,
  draft: EmailDraft,
): Promise<JudgeScore> => {
  const prompt = [
    `# Draft`,
    `Subject: ${draft.subject}`,
    draft.body,
    '',
    `# Target context`,
    `${brief.targetName} (${brief.targetAffiliation}) — type=${brief.targetType}, register=${brief.recommendedRegister}.`,
    `Hook the drafter chose: ${hook.claim} (cite: ${hook.citation})`,
    '',
    `# Your task`,
    `You are an INDEPENDENT judge — not the drafter. Score this draft 1–5 on each rubric dimension. Compute total. Set rewriteNeeded true if total < 18 or any dimension ≤ 2.`,
    `In notes, write 1–2 sentences telling the human reviewer the single most important thing to fix or check.`,
  ].join('\n');

  return callJson('judge', prompt, JudgeScoreSchema);
};
