import { z } from 'zod';

// A single way to position Verlet to this person, grounded in something
// specific from the research brief.
export const SellingAngleSchema = z.object({
  headline: z
    .string()
    .describe('5–10 word title for this angle. E.g. "Real-data side of RoboCasa365 is the bottleneck".'),
  evidence: z
    .string()
    .describe(
      'The specific fact from the brief that supports this angle. Must be verifiable — paper title, dataset stat, funding number, hire, project name. No paraphrasing.',
    ),
  citation: z
    .string()
    .describe('URL, paper title, or other concrete pointer the human can verify in 5 seconds.'),
  verletCapability: z
    .enum(['teleop', 'ego', 'umi', 'eval', 'dagger'])
    .describe('Which Verlet service this angle maps to.'),
  pitchLogic: z
    .string()
    .describe(
      '2–3 sentences explaining WHY this angle should resonate with this specific person — what bottleneck they have that Verlet solves. Show your reasoning; do not just restate the angle.',
    ),
  likelyObjection: z
    .string()
    .describe('The most plausible reason this person would push back on this pitch.'),
  objectionResponse: z
    .string()
    .describe(
      'One sentence Mateo could use to address the objection. Cite a Verlet fact (pricing, ops detail, sample-data link, academic discount) where useful.',
    ),
  strength: z
    .number()
    .describe('Integer 1–5. How likely this angle is to land, ranked relative to the others.'),
});

// A short opener Mateo can adapt — the goal is to give him material to riff
// on, not a finished email.
export const OpenerIdeaSchema = z.object({
  text: z
    .string()
    .describe(
      'A 1–2 sentence opener leveraging one angle. Sounds like a peer, not a vendor. No "I came across your work".',
    ),
  leansOn: z.string().describe('Which angle (headline) this opener uses.'),
  register: z
    .enum(['academic', 'commercial'])
    .describe('Which register this opener is calibrated for.'),
});

export const SellingBrainstormSchema = z.object({
  // Headline + summary read first; the rest is for digging in.
  topAngleHeadline: z
    .string()
    .describe('The single strongest angle headline. Lands in Person.hookSummary in the CRM.'),

  oneLineWho: z
    .string()
    .describe('25 words on who this person is and why they matter for Verlet.'),

  angles: z
    .array(SellingAngleSchema)
    .describe('3–5 distinct angles ranked by strength desc. Each must be distinct, not a paraphrase of the others.'),

  openerIdeas: z
    .array(OpenerIdeaSchema)
    .describe('3–4 candidate opening lines spread across the top angles. Different phrasings; same angles allowed.'),

  avoid: z
    .array(z.string())
    .describe('Anti-angles. Things NOT to lead with for this person (e.g. "do not lead with cost — they have grant funding").'),

  introPaths: z
    .array(z.string())
    .describe('Possible warm-intro paths or shared connections worth checking before sending cold.'),
});

export type SellingAngle = z.infer<typeof SellingAngleSchema>;
export type OpenerIdea = z.infer<typeof OpenerIdeaSchema>;
export type SellingBrainstorm = z.infer<typeof SellingBrainstormSchema>;
