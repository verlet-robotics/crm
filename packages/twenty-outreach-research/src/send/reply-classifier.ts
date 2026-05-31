// Lightweight reply intent classifier. Bucketing 5 outcomes lets us route
// follow-ups: positives become tasks, OOO/auto-replies get suppressed for a
// day, unsubscribes flip the person to SKIPPED.
//
// Schema is deliberately small to stay reliable on the (cheaper) Llama 70b
// extractor — see [[reference-llm-router]].
import { z } from 'zod';

import { callJson } from '../lib/llm-router.js';

export const ReplyClassificationSchema = z.object({
  disposition: z
    .enum(['POSITIVE', 'QUESTION', 'NEGATIVE', 'UNSUBSCRIBE', 'OUT_OF_OFFICE', 'UNCLEAR'])
    .describe('Single best bucket for the reply.'),
  oneLineReason: z
    .string()
    .describe('One short sentence on why this bucket fits, citing the reply.'),
  suggestedNextStep: z
    .string()
    .describe(
      'What Mateo should do next. Concrete, ≤1 sentence (e.g., "Reply with a 30-min calendar link", "Wait until OOO end-date").',
    ),
});

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

export const classifyReply = async (
  replyBody: string,
  context: { sentSubject?: string; sentBody?: string } = {},
): Promise<ReplyClassification> => {
  const userPrompt = `Classify the following reply to a cold outreach email about Verlet Robotics (robotics manipulation data + evaluation services).

== ORIGINAL OUTREACH ==
Subject: ${context.sentSubject ?? '(unknown)'}
${context.sentBody ?? '(not provided)'}

== REPLY ==
${replyBody}

Pick the single best disposition:
- POSITIVE: interested, asks for a meeting, wants pricing/details
- QUESTION: substantive question that deserves a thoughtful reply (not the same as POSITIVE — they aren't yet bought-in)
- NEGATIVE: not interested, "remove", "not a fit"
- UNSUBSCRIBE: explicit unsubscribe request
- OUT_OF_OFFICE: auto-reply, vacation, parental leave, etc.
- UNCLEAR: ambiguous, doesn't fit cleanly

Give a one-sentence reason citing specific phrasing from the reply, and a concrete next-step.`;

  return callJson<ReplyClassification>('extractor', userPrompt, ReplyClassificationSchema);
};
