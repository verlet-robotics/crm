import { z } from 'zod';

export const EmailDraftSchema = z.object({
  subject: z.string().describe('Email subject — keep under 80 chars, ideally 6 words or fewer.'),
  body: z.string(),
  wordCount: z.number().describe('Whole-number word count of the body.'),
  hookUsed: z.string().describe('Which hookCandidate was used (its claim text).'),
  signerName: z.enum(['Mateo Sanchez', 'Charlie Humphreys', 'Xiatao Sun']),
});

export const TwoVariantOutputSchema = z.object({
  shortVariant: EmailDraftSchema.describe('Tight ~120-word version.'),
  longVariant: EmailDraftSchema.describe('~200-word version with more value-prop detail.'),
  hookRationale: z.string().describe('Why this hook was chosen over the others.'),
});

// Numeric bounds are enforced in the prompt; Anthropic's structured-output
// API rejects schema-level min/max on numbers.
// Numeric bounds + int constraints are enforced via prompt — Anthropic's
// structured-output API rejects min/max and bounded-integer schemas.
export const JudgeScoreSchema = z.object({
  specificity: z.number().describe('Integer 1–5.'),
  hookPlausibility: z.number().describe('Integer 1–5.'),
  salesBotSmell: z.number().describe('Integer 1–5 (higher = less smell).'),
  length: z.number().describe('Integer 1–5.'),
  ctaClarity: z.number().describe('Integer 1–5.'),
  total: z.number().describe('Sum of the five scores. Integer 5–25.'),
  rewriteNeeded: z.boolean(),
  notes: z.string(),
});

export const CritiqueOutputSchema = z.object({
  shortScore: JudgeScoreSchema,
  longScore: JudgeScoreSchema,
  shortRewrite: EmailDraftSchema.nullable().describe('If shortScore.rewriteNeeded, the rewritten draft. Else null.'),
  longRewrite: EmailDraftSchema.nullable(),
});

export type EmailDraft = z.infer<typeof EmailDraftSchema>;
export type TwoVariantOutput = z.infer<typeof TwoVariantOutputSchema>;
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;
export type CritiqueOutput = z.infer<typeof CritiqueOutputSchema>;
