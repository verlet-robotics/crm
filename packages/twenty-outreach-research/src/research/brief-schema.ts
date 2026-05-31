import { z } from 'zod';

export const HookCandidateSchema = z.object({
  source: z.enum(['paper', 'news', 'social', 'lab_page', 'funding', 'hiring', 'github']),
  claim: z.string().describe('One-sentence statement of the personalization angle.'),
  citation: z
    .string()
    .describe('Title, URL, or other concrete pointer the human reviewer can verify.'),
  freshness: z
    .enum(['<30d', '30-90d', '90-365d', '>1y', 'evergreen'])
    .describe('How recent this signal is.'),
  specificity: z
    .number()
    .describe('Integer 1–5. 1=generic, 5=names a specific paper/round/hire/project.'),
});

export const ResearchBriefSchema = z.object({
  targetName: z.string(),
  targetAffiliation: z.string(),
  targetType: z.enum(['UNIVERSITY_PI', 'AI_LAB', 'HUMANOID_CO']),

  // Anthropic's structured-output API rejects schema bounds; the 2–5 size and
  // ranking expectations are enforced in the synthesizer prompt.
  hookCandidates: z
    .array(HookCandidateSchema)
    .describe('Best 2–5 hooks ranked by specificity desc. Aim for 3.'),

  technicalProfile: z.object({
    focus: z.string().describe('Research focus in 1–2 sentences.'),
    stack: z
      .array(z.string())
      .describe('Concrete tools/embodiments/data formats they use (e.g. ALOHA, LeRobot, OpenPI).'),
    knownPainPoints: z
      .array(z.string())
      .describe('Bottlenecks evident from their public work (data collection cost, eval scale, etc.).'),
  }),

  commercialSignals: z.object({
    funding: z.array(z.string()).describe('Recent rounds, if any, with date + amount.'),
    hiring: z.array(z.string()).describe('Recent eng/data hires or open reqs.'),
    productLaunches: z.array(z.string()),
  }),

  mutualConnections: z.array(z.string()).describe('Shared collaborators, advisors, or past institutions.'),

  bestFitVerletService: z.enum(['teleop', 'ego', 'umi', 'eval', 'dagger']),
  recommendedRegister: z.enum(['academic', 'commercial']),

  oneLineSummary: z.string().describe('25 words or fewer. Will land in the CRM hookSummary field.'),
});

export type HookCandidate = z.infer<typeof HookCandidateSchema>;
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;
