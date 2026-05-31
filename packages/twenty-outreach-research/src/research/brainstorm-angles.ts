import { callJson } from '../lib/llm-router.js';
import type { ResearchBrief } from './brief-schema.js';
import { SellingBrainstormSchema, type SellingBrainstorm } from './angles-schema.js';

const formatBriefForBrainstorm = (brief: ResearchBrief): string => {
  return [
    `Target: ${brief.targetName}`,
    `Affiliation: ${brief.targetAffiliation}`,
    `Buyer archetype: ${brief.targetType}`,
    `Suggested register: ${brief.recommendedRegister}`,
    `Best-fit service from L2: ${brief.bestFitVerletService}`,
    `One-line: ${brief.oneLineSummary}`,
    '',
    `Hook candidates from L2 (raw evidence — use as the substrate for angles):`,
    ...brief.hookCandidates.map(
      (h, i) =>
        `  ${i + 1}. [${h.source} · spec=${h.specificity}/5 · ${h.freshness}] ${h.claim}\n     cite: ${h.citation}`,
    ),
    '',
    `Technical profile:`,
    `  focus: ${brief.technicalProfile.focus}`,
    `  stack: ${brief.technicalProfile.stack.join(', ')}`,
    `  known pain: ${brief.technicalProfile.knownPainPoints.join('; ')}`,
    '',
    `Commercial signals: funding=${brief.commercialSignals.funding.join('; ') || 'none'} | hiring=${brief.commercialSignals.hiring.join('; ') || 'none'} | launches=${brief.commercialSignals.productLaunches.join('; ') || 'none'}`,
    `Mutual connections: ${brief.mutualConnections.join(', ') || 'none'}`,
  ].join('\n');
};

const PROMPT_INSTRUCTIONS = `
# Your task

You are NOT writing an email. Mateo will write the email himself. Your job is to give Mateo the strategic substrate so he can write quickly: distinct angles, ranked, with the evidence each one rests on, plus a few opener phrasings he can riff on.

Hard rules for the brainstorm:

1. **Every angle is grounded.** No abstract pitches. Each angle must point to a specific paper, dataset stat, funding round, hire, talk, or project from the brief above. If you can't cite it, drop the angle.

2. **Angles must be distinct.** "RoboCasa365 needs more real data" and "ManipulationNet needs more real eval" can be two separate angles. "Their lab does manipulation" and "their lab does dexterous manipulation" are paraphrases — collapse them.

3. **Map each angle to ONE Verlet capability.** teleop / ego / umi / eval / dagger. Don't say "all of the above".

4. **PitchLogic shows reasoning, not slogans.** "This resonates because ManipulationNet is explicitly about standardizing physical eval, which is what Verlet's managed-eval service does at scale" — not "this is a great fit".

5. **Likely objections are specific.** "Their NSF grant probably restricts paying for commercial data" is good. "They might not respond" is useless.

6. **ObjectionResponse should reference a Verlet fact.** Academic discount, 100-hr minimum, sample-data link, Rwanda ops numbers, Apollo Lab pedigree. Don't hand-wave.

7. **Opener ideas are starting points, not finished sentences.** Each opener leans on one angle and uses the same fact-grounded specificity. Mateo will edit them.

8. **avoid list is real.** If they're academic with grant funding, "do not lead with cost". If they just raised, "do not pitch on tight budget logic". Be specific to THIS person.

9. **introPaths surface possible warm intros.** Apollo Lab at Yale (Mateo's pedigree), shared collaborators, conference overlap, alumni networks. Only list real ones.

Aim for 4 distinct angles ranked by strength. Aim for 3 opener ideas. 2–3 items in avoid is normal.

Return the structured JSON only.
`;

// Company mode: the subject is an ORG, not a person. Angles target the company's
// buying signals, and each opener names WHICH role archetype it's aimed at
// (economic buyer vs technical champion) so Mateo can route it to the right contact.
const COMPANY_PROMPT_INSTRUCTIONS = `
# Your task

You are NOT writing an email. You are giving Mateo strategic substrate to reach out to a COMPANY (not one named person). Produce distinct, ranked angles for why Verlet fits this organization, plus opener phrasings.

Hard rules:

1. **Every angle is grounded** in a specific company fact from the brief — a funding round, product launch, hire, public roadmap, or stated bottleneck. No abstract pitches.

2. **Angles must be distinct** and each maps to ONE Verlet capability (teleop / ego / umi / eval / dagger).

3. **oneLineWho describes the COMPANY** (what they build + why they're a Verlet fit), not an individual.

4. **PitchLogic is org-level reasoning** — why this resonates given the company's stage/product/bottleneck.

5. **For each opener, state which contact archetype it targets** in 'leansOn' or the text — e.g. "(for the economic buyer: CEO/Head of Partnerships)" vs "(for the technical champion: VP Eng/Robot Learning Lead)". Business-side openers lead with cost/throughput/partnership; technical openers lead with data quality, eval rigor, sim-to-real.

6. **likelyObjection / objectionResponse** are specific and cite a Verlet fact (Rwanda ops scale, 100-hr minimum, managed-eval, Apollo Lab pedigree).

7. **avoid** is real and company-specific (e.g. "don't pitch tight-budget logic to a company that just raised a large round").

8. **introPaths** surface real warm intros (Apollo Lab pedigree, shared investors, conference overlap).

Aim for 4 distinct angles ranked by strength. Aim for 3–4 opener ideas spanning business and technical archetypes. Return the structured JSON only.
`;

export const brainstormAngles = async (
  brief: ResearchBrief,
  opts: { subject?: 'person' | 'company' } = {},
): Promise<SellingBrainstorm> => {
  const userPrompt = [
    '# Research brief',
    formatBriefForBrainstorm(brief),
    '',
    opts.subject === 'company' ? COMPANY_PROMPT_INSTRUCTIONS : PROMPT_INSTRUCTIONS,
  ].join('\n');
  return callJson('writer', userPrompt, SellingBrainstormSchema);
};
