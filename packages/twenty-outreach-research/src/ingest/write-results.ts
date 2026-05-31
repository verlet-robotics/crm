// Write a completed research + brainstorm pipeline result back into Twenty:
//   - ResearchBrief → Note 1 attached to the Person (concise markdown)
//   - SellingBrainstorm → Note 2 attached to the same Person (angles + openers)
//   - Company.researchSummary ← org-level markdown (shared across people)
//   - Person.hookSummary ← top angle headline
//   - Person.researchStatus ← BRIEFED (the "ready for Mateo to write" state)
import {
  attachNoteToPerson,
  reconcilePersonEmail,
  recomputeCompanyOutreachStage,
  updateCompanyResearchSummary,
  updatePersonFields,
} from '../lib/twenty-client.js';
import type { ResearchBrief } from '../research/brief-schema.js';
import type { SellingBrainstorm } from '../research/angles-schema.js';

export const renderBriefMarkdown = (brief: ResearchBrief): string => {
  const lines: string[] = [];
  lines.push(`# ${brief.targetName} — research brief`);
  lines.push(`_${brief.targetAffiliation} · ${brief.targetType} · ${brief.recommendedRegister} register_`);
  lines.push('');
  lines.push(`**TL;DR:** ${brief.oneLineSummary}`);
  lines.push(`**Best-fit Verlet service (L2 guess):** ${brief.bestFitVerletService}`);
  lines.push('');

  lines.push(`## Technical profile`);
  lines.push(`- **Focus:** ${brief.technicalProfile.focus}`);
  if (brief.technicalProfile.stack.length) {
    lines.push(`- **Stack:** ${brief.technicalProfile.stack.join(', ')}`);
  }
  if (brief.technicalProfile.knownPainPoints.length) {
    lines.push(`- **Pain points evident from public work:**`);
    brief.technicalProfile.knownPainPoints.forEach((p) => lines.push(`  - ${p}`));
  }
  lines.push('');

  const cs = brief.commercialSignals;
  if (cs.funding.length || cs.hiring.length || cs.productLaunches.length) {
    lines.push(`## Commercial signals`);
    if (cs.funding.length) {
      lines.push(`**Funding**`);
      cs.funding.forEach((f) => lines.push(`- ${f}`));
    }
    if (cs.hiring.length) {
      lines.push(`**Hiring**`);
      cs.hiring.forEach((h) => lines.push(`- ${h}`));
    }
    if (cs.productLaunches.length) {
      lines.push(`**Launches**`);
      cs.productLaunches.forEach((l) => lines.push(`- ${l}`));
    }
    lines.push('');
  }

  if (brief.mutualConnections.length) {
    lines.push(`## Mutual connections / overlap`);
    brief.mutualConnections.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }

  lines.push(`## Raw hook candidates (L2 evidence pool)`);
  brief.hookCandidates.forEach((h, i) => {
    lines.push(
      `${i + 1}. **[${h.source} · spec=${h.specificity}/5 · ${h.freshness}]** ${h.claim}`,
    );
    lines.push(`   _cite:_ ${h.citation}`);
  });

  return lines.join('\n');
};

export const renderBrainstormMarkdown = (
  target: string,
  brainstorm: SellingBrainstorm,
): string => {
  const lines: string[] = [];
  lines.push(`# ${target} — selling angles`);
  lines.push(`_Strategic substrate for Mateo. Pick an angle, write the email yourself._`);
  lines.push('');
  lines.push(`**Top angle:** ${brainstorm.topAngleHeadline}`);
  lines.push(`**Who they are:** ${brainstorm.oneLineWho}`);
  lines.push('');

  lines.push(`## Angles (ranked)`);
  brainstorm.angles.forEach((a, i) => {
    lines.push('');
    lines.push(`### ${i + 1}. ${a.headline}  _(strength ${a.strength}/5 → ${a.verletCapability})_`);
    lines.push(`**Evidence:** ${a.evidence}`);
    lines.push(`**Cite:** ${a.citation}`);
    lines.push(`**Why it lands:** ${a.pitchLogic}`);
    lines.push(`**Likely objection:** ${a.likelyObjection}`);
    lines.push(`**Response:** ${a.objectionResponse}`);
  });
  lines.push('');

  if (brainstorm.openerIdeas.length) {
    lines.push(`## Opener ideas (riff, don't ship)`);
    brainstorm.openerIdeas.forEach((o, i) => {
      lines.push('');
      lines.push(`**${i + 1}. (${o.register}, leans on "${o.leansOn}")**`);
      lines.push(`> ${o.text}`);
    });
    lines.push('');
  }

  if (brainstorm.avoid.length) {
    lines.push(`## Do NOT lead with`);
    brainstorm.avoid.forEach((a) => lines.push(`- ${a}`));
    lines.push('');
  }

  if (brainstorm.introPaths.length) {
    lines.push(`## Possible warm intros`);
    brainstorm.introPaths.forEach((p) => lines.push(`- ${p}`));
  }

  return lines.join('\n');
};

// Stub email draft from the top angle. This is NOT meant to be sent —
// it's a starting point so Mateo edits prose instead of staring at a blank
// `emailDraftFinal`. Format:
//   Subject: <truncated top angle as a question>
//   Hi <firstName>,
//   <best opener idea>
//   <one-line value-prop riff on the top angle>
//   <CTA>
//   — Mateo
//
// The final paragraph is intentionally explicit so Mateo can't accidentally
// send it without editing.
const renderStubEmail = (
  firstName: string,
  brief: ResearchBrief,
  brainstorm: SellingBrainstorm,
): string => {
  const topAngle = brainstorm.angles[0];
  const opener =
    brainstorm.openerIdeas[0]?.text ??
    `I came across your recent work in ${brief.technicalProfile.focus}.`;

  const subjectSeed = topAngle?.headline ?? brainstorm.topAngleHeadline;
  const subject = subjectSeed.length > 70 ? `${subjectSeed.slice(0, 67)}…` : subjectSeed;

  const valueProp = topAngle
    ? topAngle.pitchLogic.split('. ')[0] // first sentence of pitchLogic
    : 'Verlet runs 600+ hrs/week of bimanual teleop and managed evaluation in Rwanda — exactly the bottleneck most teams in your space are hitting.';

  const cta =
    'Worth a 20-min call to compare notes? Happy to send a one-pager first if you prefer.';

  return [
    `Subject: ${subject}`,
    '',
    `Hi ${firstName || 'there'},`,
    '',
    opener,
    '',
    valueProp,
    '',
    cta,
    '',
    '— Mateo',
    'Verlet Robotics',
    '',
    '<!-- DRAFT STUB — edit before approving. Generated from selling-angle #1; pick a different angle in the Selling Angles Note if this one doesn\'t land. -->',
  ].join('\n');
};

// There is no independent LLM judge in the current L3 path (the brainstorm IS
// the deliverable). We still want a sortable quality number on the Person so
// the "DRAFTED, sorted by judgeScore" review queue is meaningful. Derive a
// 0–25 package-quality score from the brainstorm's own self-ranked angle
// strengths plus signals that the package is actionable (warm intros, register
// awareness). This is a heuristic, NOT an independent judge — judgeNotes says so.
const scoreBrainstorm = (b: SellingBrainstorm): number => {
  const topStrength = Math.min(5, Math.max(0, b.angles[0]?.strength ?? 0));
  const strongAngles = b.angles.filter((a) => a.strength >= 4).length;
  let score = topStrength * 3; // up to 15 — strength of the best angle
  score += Math.min(3, strongAngles) * 2; // up to 6 — depth of strong options
  if (b.introPaths.length > 0) score += 2; // a warm path exists
  if (b.avoid.length > 0) score += 2; // register/anti-angle awareness
  return Math.min(25, score);
};

const renderJudgeNotes = (
  brief: ResearchBrief,
  b: SellingBrainstorm,
  score: number,
): string => {
  const strongAngles = b.angles.filter((a) => a.strength >= 4).length;
  return [
    `Package quality ${score}/25 — heuristic from self-ranked angle strengths (no independent judge in L3).`,
    `Best-fit Verlet service: ${brief.bestFitVerletService}; ${brief.recommendedRegister} register.`,
    `${b.angles.length} angles (${strongAngles} at strength ≥4); top: "${b.topAngleHeadline}".`,
    b.introPaths.length
      ? `${b.introPaths.length} warm-intro path(s) to vet before sending cold.`
      : 'No warm-intro path surfaced — cold send.',
    b.avoid.length ? `Lead-with caution: ${b.avoid[0]}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
};

const renderCompanySummary = (brief: ResearchBrief): string => {
  const lines = [
    `_Auto-refreshed by outreach-research pipeline. Last update via target: ${brief.targetName}_`,
    '',
    `**Profile:** ${brief.technicalProfile.focus}`,
  ];
  if (brief.technicalProfile.stack.length) {
    lines.push(`**Stack:** ${brief.technicalProfile.stack.join(', ')}`);
  }
  const cs = brief.commercialSignals;
  if (cs.funding.length) lines.push(`**Funding:** ${cs.funding.join('; ')}`);
  if (cs.hiring.length) lines.push(`**Hiring:** ${cs.hiring.join('; ')}`);
  if (cs.productLaunches.length) lines.push(`**Launches:** ${cs.productLaunches.join('; ')}`);
  return lines.join('\n');
};

export type WriteResultsInput = {
  personId: string;
  companyId?: string;
  // Used to personalize the stub email's greeting.
  firstName?: string;
  brief: ResearchBrief;
  brainstorm: SellingBrainstorm;
};

export const writeResultsToCRM = async (input: WriteResultsInput): Promise<void> => {
  console.log(`[ingest] writing brief + brainstorm to Person ${input.personId}`);

  const today = new Date().toISOString().split('T')[0];

  // 1. Concise research brief as Note 1.
  await attachNoteToPerson(
    input.personId,
    `Research brief — ${input.brief.targetName} (${today})`,
    renderBriefMarkdown(input.brief),
  );

  // 2. Selling-angles brainstorm as Note 2.
  await attachNoteToPerson(
    input.personId,
    `Selling angles — ${input.brief.targetName} (${today})`,
    renderBrainstormMarkdown(input.brief.targetName, input.brainstorm),
  );

  // 3. Org-level summary (shared with other People at the same org).
  if (input.companyId) {
    try {
      await updateCompanyResearchSummary(
        input.companyId,
        renderCompanySummary(input.brief),
      );
    } catch (err) {
      console.warn(
        `[ingest] failed to update Company.researchSummary: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // 4. Person headline fields + status + stub email draft.
  // We keep status=DRAFTED for back-compat with the existing select enum;
  // semantically it now means "research package ready, Mateo to write".
  //
  // The stub email goes into emailDraftV1 (rich-text markdown) so when Mateo
  // hits APPROVED, gmail-poll has a body to use. The stub is clearly marked
  // DRAFT STUB and asks for human edit before approval.
  const stubMarkdown = renderStubEmail(
    input.firstName ?? '',
    input.brief,
    input.brainstorm,
  );

  const judgeScore = scoreBrainstorm(input.brainstorm);
  const judgeNotes = renderJudgeNotes(input.brief, input.brainstorm, judgeScore);

  await updatePersonFields(input.personId, {
    researchStatus: 'DRAFTED',
    hookSummary: input.brainstorm.topAngleHeadline.slice(0, 240),
    emailDraftV1: { markdown: stubMarkdown },
    judgeScore,
    judgeNotes,
  });

  // Keep a verified institutional address as primary if the record carries
  // more than one email (e.g. a personal Gmail crept in during discovery).
  await reconcilePersonEmail(input.personId).catch((err) => {
    console.warn(`[ingest] email reconcile skipped: ${err instanceof Error ? err.message : err}`);
  });

  // Advance the account's Company Kanban stage (→ RESEARCHING) now that this
  // contact has a research package.
  if (input.companyId) {
    await recomputeCompanyOutreachStage(input.companyId).catch((err) => {
      console.warn(
        `[ingest] outreachStage recompute skipped: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  console.log(
    `[ingest] done — Person DRAFTED, judgeScore=${judgeScore}/25, top angle: ${input.brainstorm.topAngleHeadline}`,
  );
};
