// Optional LLM tie-breaker for the fit classifier. Only ever invoked on `review`
// verdicts (ambiguous non-empty titles) — the rule-based pass in classify-fit.ts
// handles every clear case for free. Runs on the cheap `extractor` role (free
// NIM Llama by default), and is fail-safe: any error, or an uncertain model
// answer, leaves the verdict as `review` (kept, never deleted on a guess).
import { z } from 'zod';
import { callJson } from '../lib/llm-router.js';
import { classifyFit, type FitInput, type FitVerdict } from './classify-fit.js';

const llmSchema = z.object({
  decision: z.enum(['keep', 'delete', 'uncertain']),
  reason: z.string(),
});

const POLICY = `You are screening a CRM contact for a robotics-data company's outbound sales pipeline.
The bar is ACADEMIC-LENIENT, COMPANY-STRICT:
- Academic affiliation (university / lab / institute): KEEP faculty, PIs, AND researchers (PhD, postdoc, research scientist/fellow). DELETE undergraduates and interns.
- Company (for-profit): KEEP ONLY leadership (Head/Director/VP/C-level/Founder/Manager). DELETE individual contributors (engineers, scientists, ICs) regardless of seniority.
Answer "delete" only if you are confident the person is a poor fit under this bar. If you cannot tell from the information given, answer "uncertain".`;

export const classifyFitWithLlm = async (
  input: FitInput,
  opts: { useLlm?: boolean } = {},
): Promise<FitVerdict> => {
  const ruleVerdict = classifyFit(input);
  if (!opts.useLlm || ruleVerdict.decision !== 'review') return ruleVerdict;

  const prompt = `${POLICY}

Contact:
- Job title: ${input.jobTitle ?? '(none)'}
- Organisation: ${input.companyName ?? '(unknown)'}
- Account type: ${input.accountType ?? '(unknown)'}
- Register the rules placed them in: ${ruleVerdict.register}

Return your decision.`;

  try {
    const out = await callJson('extractor', prompt, llmSchema);
    if (out.decision === 'delete') {
      return { ...ruleVerdict, decision: 'delete', reason: `LLM: ${out.reason}` };
    }
    if (out.decision === 'keep') {
      return { ...ruleVerdict, decision: 'keep', reason: `LLM: ${out.reason}` };
    }
    // 'uncertain' → keep the human-review verdict.
    return ruleVerdict;
  } catch (err) {
    console.warn(
      `[qualify] LLM tie-break failed for "${input.jobTitle ?? ''}" — leaving as review: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return ruleVerdict;
  }
};
