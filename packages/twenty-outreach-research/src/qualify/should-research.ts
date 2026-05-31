// Single gate deciding whether the (paid) deep-research pipeline should run on a
// given Person. Two independent reasons to skip — both non-destructive; the
// Person stays in the CRM, we just don't spend research credits on them:
//   1. INVESTOR account — investors are a different GTM motion (capital, not a
//      sales/outreach target), so they're never research targets.
//   2. Poor role fit — the academic-lenient / company-strict classifier says
//      `delete` (undergrad, intern, non-leadership company IC).
// Ambiguous contacts always pass through to research.
import { classifyFit } from './classify-fit.js';

export type ResearchGateInput = {
  jobTitle?: string | null;
  company?: { name?: string | null; accountType?: string | null } | null;
};

export const researchGate = (
  person: ResearchGateInput,
): { research: boolean; reason: string } => {
  const accountType = person.company?.accountType;
  if (accountType === 'INVESTOR') {
    return { research: false, reason: 'investor account — not an outreach/research target' };
  }
  const verdict = classifyFit({
    jobTitle: person.jobTitle,
    companyName: person.company?.name,
    accountType,
  });
  if (verdict.decision === 'delete') {
    return { research: false, reason: verdict.reason };
  }
  return { research: true, reason: '' };
};
