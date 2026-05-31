// Smoke test for the fit classifier. Pure logic — no API, no cost.
// Run: npx tsx src/qualify/classify-fit.smoke.ts
// Exits non-zero if any case disagrees with its expected decision.
import { classifyFit, type FitDecision, type FitInput } from './classify-fit.js';

type Case = FitInput & { expect: FitDecision; note: string };

const cases: Case[] = [
  // ── Academic — KEEP ──────────────────────────────────────────────────────
  { jobTitle: 'Professor of Computer Science', accountType: 'INSTITUTION', expect: 'keep', note: 'professor' },
  { jobTitle: 'Assistant Professor', accountType: 'INSTITUTION', expect: 'keep', note: 'asst prof' },
  { jobTitle: 'Principal Investigator', accountType: 'LAB', expect: 'keep', note: 'PI' },
  { jobTitle: 'Lab Director', accountType: 'LAB', expect: 'keep', note: 'lab director' },
  { jobTitle: 'PhD Student', accountType: 'INSTITUTION', expect: 'keep', note: 'phd lenient' },
  { jobTitle: 'Ph.D. Candidate', accountType: 'LAB', expect: 'keep', note: 'phd candidate' },
  { jobTitle: 'Postdoctoral Researcher', accountType: 'INSTITUTION', expect: 'keep', note: 'postdoc' },
  { jobTitle: 'Postdoc', accountType: 'LAB', expect: 'keep', note: 'postdoc short' },
  { jobTitle: 'Research Scientist', accountType: 'INSTITUTION', expect: 'keep', note: 'research scientist' },
  { jobTitle: 'Research Fellow', accountType: 'LAB', expect: 'keep', note: 'research fellow' },
  { jobTitle: 'Graduate Researcher', companyName: 'MIT CSAIL', expect: 'keep', note: 'academic by name' },
  // Regression: LAB accountType whose NAME has no academic keyword must still be
  // academic register — "Assistant Professor" must NOT hit the company IC rule
  // via the word "assistant". (Uppercase enum + name-less-lab bug.)
  { jobTitle: 'Assistant Professor', accountType: 'LAB', companyName: 'GRAIL at NYU', expect: 'keep', note: 'asst prof @ name-less lab' },
  { jobTitle: 'Incoming Assistant Professor', accountType: 'LAB', companyName: 'LiraLab at USC', expect: 'keep', note: 'incoming asst prof @ lab' },
  { jobTitle: 'Assistant Professor', accountType: 'INSTITUTION', companyName: 'PoRTaL Group at Cornell', expect: 'keep', note: 'asst prof @ group' },

  // ── Academic — DELETE ──────────────────────────────────────────────────────
  { jobTitle: 'Undergraduate Researcher', accountType: 'LAB', expect: 'delete', note: 'undergrad' },
  { jobTitle: 'Undergraduate Research Assistant', accountType: 'INSTITUTION', expect: 'delete', note: 'undergrad RA' },
  { jobTitle: 'BS Student', accountType: 'INSTITUTION', expect: 'delete', note: 'BS student' },
  { jobTitle: 'Research Intern', accountType: 'LAB', expect: 'delete', note: 'intern beats researcher' },
  { jobTitle: 'Summer Research Intern', accountType: 'INSTITUTION', expect: 'delete', note: 'summer intern' },
  { jobTitle: 'REU Student', accountType: 'INSTITUTION', expect: 'delete', note: 'REU' },

  // ── Academic — REVIEW (uncertain, kept) ─────────────────────────────────────
  { jobTitle: '', accountType: 'INSTITUTION', expect: 'review', note: 'no title academic' },
  { jobTitle: 'Student', accountType: 'INSTITUTION', expect: 'review', note: 'bare student' },
  { jobTitle: 'Visiting Scholar', accountType: 'LAB', expect: 'keep', note: 'scholar keeps' },
  { jobTitle: 'Lab Administrator', accountType: 'LAB', expect: 'review', note: 'admin uncertain' },

  // ── Company — KEEP (leadership) ─────────────────────────────────────────────
  { jobTitle: 'CTO', accountType: 'COMPANY', expect: 'keep', note: 'cto' },
  { jobTitle: 'Chief Executive Officer', accountType: 'COMPANY', expect: 'keep', note: 'ceo' },
  { jobTitle: 'VP of Engineering', accountType: 'COMPANY', expect: 'keep', note: 'vp' },
  { jobTitle: 'Head of Robotics', accountType: 'COMPANY', expect: 'keep', note: 'head of' },
  { jobTitle: 'Director of Product', accountType: 'COMPANY', expect: 'keep', note: 'director' },
  { jobTitle: 'Co-Founder', accountType: 'COMPANY', expect: 'keep', note: 'founder' },
  { jobTitle: 'Engineering Manager', accountType: 'COMPANY', expect: 'keep', note: 'manager' },
  { jobTitle: 'Founding Engineer', accountType: 'COMPANY', expect: 'keep', note: 'founding eng = leadership' },
  { jobTitle: 'Founding Scientist', accountType: 'COMPANY', expect: 'keep', note: 'founding scientist' },

  // ── Company — DELETE (ICs) ──────────────────────────────────────────────────
  { jobTitle: 'Software Engineer', accountType: 'COMPANY', expect: 'delete', note: 'swe' },
  { jobTitle: 'Senior Robotics Engineer', accountType: 'COMPANY', expect: 'delete', note: 'senior IC' },
  { jobTitle: 'Staff Software Engineer', accountType: 'COMPANY', expect: 'delete', note: 'staff IC' },
  { jobTitle: 'Principal Engineer', accountType: 'COMPANY', expect: 'delete', note: 'principal IC' },
  { jobTitle: 'Machine Learning Scientist', accountType: 'COMPANY', expect: 'delete', note: 'ml scientist IC' },
  { jobTitle: 'Member of Technical Staff', accountType: 'COMPANY', expect: 'delete', note: 'MTS' },
  { jobTitle: 'Research Engineer', accountType: 'COMPANY', expect: 'delete', note: 'company research eng IC' },

  // ── Company — REVIEW ────────────────────────────────────────────────────────
  { jobTitle: '', accountType: 'COMPANY', expect: 'review', note: 'no title company' },
  { jobTitle: 'Strategist', accountType: 'COMPANY', expect: 'review', note: 'odd company title' },
  { jobTitle: 'Autonomy Team Lead', accountType: 'COMPANY', expect: 'review', note: 'team lead borderline' },
  { jobTitle: 'Tech Lead', accountType: 'COMPANY', expect: 'review', note: 'tech lead borderline' },
];

let failed = 0;
const rows: string[] = [];
for (const c of cases) {
  const v = classifyFit(c);
  const ok = v.decision === c.expect;
  if (!ok) failed++;
  rows.push(
    `${ok ? '✓' : '✗'}  ${c.expect.padEnd(6)} got ${v.decision.padEnd(6)} [${v.tier}]  ${c.note} — "${c.jobTitle ?? ''}"`,
  );
}

console.log(rows.join('\n'));
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) {
  console.error(`\n${failed} case(s) FAILED`);
  process.exit(1);
}
