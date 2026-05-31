// Write a company-level research result back to Twenty (run-for-company):
//   - Company brief  → Note on the Company + Company.researchSummary
//   - Selling angles → Note on the Company
//   - For each recommended contact: set Person.outreachRole
//   - Business picks additionally get a light role-hook (Person.hookSummary) +
//     a short Note pointing at the company brief, and researchStatus → DRAFTED.
//     (Technical picks are deep-researched separately via runForPerson, which
//     already set their brief + status; here we only stamp outreachRole.)
import {
  attachNoteToCompany,
  attachNoteToPerson,
  updateCompanyResearchSummary,
  updatePersonFields,
} from '../lib/twenty-client.js';
import { renderBriefMarkdown, renderBrainstormMarkdown } from './write-results.js';
import type { ResearchBrief } from '../research/brief-schema.js';
import type { SellingBrainstorm } from '../research/angles-schema.js';
import type { RecommendedContact } from '../contacts/select-recommended.js';

export type WriteCompanyResultsInput = {
  companyId: string;
  companyName: string;
  brief: ResearchBrief;
  brainstorm: SellingBrainstorm;
  business: RecommendedContact[];
  technical: RecommendedContact[];
};

// Pick the lead angle to seed a business contact's hook — prefer a
// commercial-register opener, fall back to the top angle headline.
const businessHook = (brainstorm: SellingBrainstorm): string => {
  const commercial = brainstorm.openerIdeas.find((o) => o.register === 'commercial');
  return (commercial?.leansOn ?? brainstorm.topAngleHeadline).slice(0, 240);
};

export const writeCompanyResults = async (input: WriteCompanyResultsInput): Promise<void> => {
  const today = new Date().toISOString().split('T')[0];
  const { companyId, companyName, brief, brainstorm } = input;

  // 1. Company-level Notes + researchSummary.
  await attachNoteToCompany(
    companyId,
    `Company brief — ${companyName} (${today})`,
    renderBriefMarkdown(brief),
  );
  await attachNoteToCompany(
    companyId,
    `Selling angles — ${companyName} (${today})`,
    renderBrainstormMarkdown(companyName, brainstorm),
  );
  await updateCompanyResearchSummary(companyId, renderBriefMarkdown(brief)).catch((err) => {
    console.warn(`[ingest-company] researchSummary update skipped: ${err instanceof Error ? err.message : err}`);
  });

  // 2. Technical picks — research already written by runForPerson; just stamp the role.
  for (const c of input.technical) {
    await updatePersonFields(c.id, { outreachRole: c.outreachRole }).catch((err) => {
      console.warn(`[ingest-company] outreachRole on ${c.id} skipped: ${err instanceof Error ? err.message : err}`);
    });
  }

  // 3. Business picks — light role-hook from the company brief, no deep research.
  const hook = businessHook(brainstorm);
  for (const c of input.business) {
    const who = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'contact';
    await updatePersonFields(c.id, {
      outreachRole: c.outreachRole,
      researchStatus: 'DRAFTED',
      hookSummary: `[business] ${hook}`.slice(0, 240),
    }).catch((err) => {
      console.warn(`[ingest-company] business pick ${c.id} skipped: ${err instanceof Error ? err.message : err}`);
    });
    await attachNoteToPerson(
      c.id,
      `Outreach angle — ${who} @ ${companyName} (${today})`,
      [
        `_Business contact (${c.outreachRole}). Outreach material is the **company brief + selling angles** on the ${companyName} company record — this person was not deep-researched individually._`,
        '',
        `**Role:** ${c.jobTitle ?? '—'}`,
        `**Lead angle:** ${brainstorm.topAngleHeadline}`,
        `**Who they are (org):** ${brainstorm.oneLineWho}`,
      ].join('\n'),
    ).catch((err) => {
      console.warn(`[ingest-company] business note ${c.id} skipped: ${err instanceof Error ? err.message : err}`);
    });
  }

  console.log(
    `[ingest-company] wrote company brief + angles; tagged ${input.technical.length} technical + ${input.business.length} business contacts`,
  );
};
