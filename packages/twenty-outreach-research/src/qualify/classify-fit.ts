// Fit classifier — decides whether a contact is worth running the (paid) deep
// research pipeline on, and worth keeping in the CRM at all.
//
// Bar: ACADEMIC-LENIENT, COMPANY-STRICT.
//   • Academic labs/institutions: keep faculty/PIs AND researchers
//     (PhD, postdoc, research scientist/fellow). Drop undergrads + interns.
//   • Companies: keep ONLY leadership (Head/Director/VP/C-level/Founder/Manager).
//     Drop individual contributors (engineers, scientists, ICs).
//
// Deletion is destructive (soft-delete, but still), so the classifier is
// asymmetric: it only returns `delete` when it positively identifies a
// disqualifying signal. Anything genuinely ambiguous resolves to `review`
// (kept, but surfaced for a human) — never deleted on a guess.

export type FitTier =
  | 'academic_faculty' // professor, PI, faculty, lab director
  | 'academic_researcher' // phd, postdoc, research scientist/fellow/associate
  | 'company_leadership' // exec / manager / founder at a company
  | 'undergrad'
  | 'intern'
  | 'company_ic' // non-leadership engineer/scientist/IC at a company
  | 'unknown';

export type FitDecision = 'keep' | 'delete' | 'review';

export type FitVerdict = {
  decision: FitDecision;
  tier: FitTier;
  // Was this contact judged in the academic-lenient or company-strict register?
  register: 'academic' | 'company';
  reason: string;
};

export type FitInput = {
  jobTitle?: string | null;
  companyName?: string | null;
  accountType?: string | null;
};

// ── Context detection ──────────────────────────────────────────────────────
// accountType (set by the Notion migration: Company / Lab / Institution) is the
// primary signal. Fall back to a conservative company-name heuristic only when
// accountType is missing. We deliberately do NOT treat bare "robotics" as
// academic — too many robotics *companies* carry it in their name.
const ACADEMIC_NAME = /university|college|\binstitut|\blab\b|laboratory|\.edu\b/i;

// accountType in the live data is UPPERCASE (LAB / INSTITUTION / COMPANY /
// INVESTOR / MISC). Normalise so casing can never silently route a lab into the
// company (strict) register and false-delete a professor.
export const isAcademicRegister = (
  accountType?: string | null,
  companyName?: string | null,
): boolean => {
  const at = accountType?.toUpperCase();
  if (at === 'INSTITUTION' || at === 'LAB') return true;
  if (at === 'COMPANY' || at === 'INVESTOR' || at === 'MISC') return false;
  // No (or unknown) accountType — fall back to the company name.
  return !!companyName && ACADEMIC_NAME.test(companyName);
};

// ── Title signals ───────────────────────────────────────────────────────────
// Universal disqualifiers (an intern/undergrad is a poor fit in any register).
const INTERN =
  /\bintern(ship)?\b|\bco-?op\b|\btrainee\b|apprentice|summer (student|research|analyst|intern)/i;
const UNDERGRAD =
  /\bundergrad(uate)?\b|bachelor'?s?\b|\bb\.?s\.?c?\.?\s*(student|candidate)|\bb\.?a\.?\s*(student|candidate)|\bfreshman\b|\bsophomore\b|first[- ]year (under)?grad|\breu\b|\bhigh[- ]school\b|class of \d{4}/i;

// Intrinsically-academic trainee titles — a PhD/postdoc/grad-student title only
// exists in academia (a company would say "Research Scientist", never "PhD
// Student"). These KEEP regardless of how the org is labelled, which guards
// against deleting a grad student whose org we failed to recognise as academic.
// (Note: "research scientist/fellow/engineer" are NOT here — those are
// register-dependent because they exist at companies too.)
const ACADEMIC_TRAINEE =
  /\bph\.?\s?d\b|doctoral|\bd\.?phil\b|\bpostdoc\b|post[- ]?doctoral|\bm\.?s\.?c?\.?\s*(student|candidate)|master'?s?\s*(student|candidate)|grad(uate)?\s*(student|researcher|research assistant)/i;

// Academic — KEEP.
const FACULTY =
  /professor|\bprof\b|faculty|lecturer|\bp\.?i\.?\b|principal investigator|lab director|department (chair|head)|\bdean\b|emeritus|research (group )?lead/i;
const ACADEMIC_RESEARCHER =
  /\bph\.?\s?d\b|doctoral|\bd\.?phil\b|\bpostdoc\b|post[- ]?doctoral|\bm\.?s\.?c?\.?\s*(student|candidate)|master'?s?\s*(student|candidate)|grad(uate)?\s*(student|researcher|research assistant)|research (scientist|fellow|associate|engineer|assistant|staff)|\bscholar\b|\bscientist\b|\bresearcher\b/i;

// Company — KEEP (leadership only).
// Note: "founding" (Founding Engineer/Scientist/Member) counts as leadership —
// at an early-stage startup the founding team are decision-makers/champions,
// not rank-and-file ICs.
const LEADERSHIP =
  /\b(ceo|cto|cfo|coo|cio|cmo|cro|cpo|cdo|cso)\b|\bchief\b|\bvp\b|vice president|\bhead of\b|\bdirector\b|founder|co-?founder|\bfounding\b|\bpresident\b|\bowner\b|managing (director|partner)|\bpartner\b|general manager|\bmanager\b/i;

// Company — DELETE (individual contributors, incl. senior ICs without
// people-leadership: staff/principal/lead/senior engineer all drop under the
// strict company bar).
// Note: "lead" (Team Lead / Tech Lead / Lead Engineer) is deliberately NOT here.
// A lead carries some authority — too borderline to auto-delete under the strict
// bar, so those titles fall through to `review` (kept, flagged) instead.
const COMPANY_IC =
  /\bengineer\b|\bdeveloper\b|\bswe\b|programmer|scientist|researcher|\banalyst\b|designer|architect|specialist|consultant|technician|member of technical staff|\bmts\b|\bstaff\b|\bsenior\b|\bprincipal\b|\bassociate\b|coordinator|administrator|\bassistant\b/i;

export const classifyFit = (input: FitInput): FitVerdict => {
  const title = (input.jobTitle ?? '').trim();
  const academic = isAcademicRegister(input.accountType, input.companyName);
  const register: FitVerdict['register'] = academic ? 'academic' : 'company';

  // Universal disqualifiers win in both registers.
  if (INTERN.test(title)) {
    return { decision: 'delete', tier: 'intern', register, reason: `intern/trainee role ("${title}")` };
  }
  if (UNDERGRAD.test(title)) {
    return { decision: 'delete', tier: 'undergrad', register, reason: `undergraduate ("${title}")` };
  }

  // Intrinsically-academic trainee titles keep regardless of register — a
  // mislabelled org must never cause a grad student to be deleted.
  if (ACADEMIC_TRAINEE.test(title)) {
    return {
      decision: 'keep',
      tier: 'academic_researcher',
      register: 'academic',
      reason: `academic trainee ("${title}")`,
    };
  }

  if (academic) {
    if (FACULTY.test(title)) {
      return { decision: 'keep', tier: 'academic_faculty', register, reason: `faculty/PI ("${title}")` };
    }
    if (ACADEMIC_RESEARCHER.test(title)) {
      return {
        decision: 'keep',
        tier: 'academic_researcher',
        register,
        reason: `academic researcher ("${title}")`,
      };
    }
    if (title === '') {
      return {
        decision: 'review',
        tier: 'unknown',
        register,
        reason: 'no job title at an academic affiliation — review manually',
      };
    }
    // Academic but an unrecognised title (bare "student", admin, "visiting",
    // etc.). Lenient register → keep but flag, never auto-delete.
    return {
      decision: 'review',
      tier: 'unknown',
      register,
      reason: `unrecognised academic role ("${title}") — review manually`,
    };
  }

  // Company register (strict).
  if (LEADERSHIP.test(title)) {
    return { decision: 'keep', tier: 'company_leadership', register, reason: `company leadership ("${title}")` };
  }
  if (title === '') {
    return {
      decision: 'review',
      tier: 'unknown',
      register,
      reason: 'no job title at a company — review manually',
    };
  }
  if (COMPANY_IC.test(title)) {
    return {
      decision: 'delete',
      tier: 'company_ic',
      register,
      reason: `non-leadership IC at a company ("${title}")`,
    };
  }
  return {
    decision: 'review',
    tier: 'unknown',
    register,
    reason: `unrecognised company role ("${title}") — review manually`,
  };
};
