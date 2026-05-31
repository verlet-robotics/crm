// Canonical target-role taxonomy for Verlet contact discovery.
//
// What Verlet sells — manipulation training data, model evaluation, DAgger —
// defines a standard buying committee that's the SAME shape at any company.
// This module is the single source of truth for "is this person a target, and
// which role do they play", replacing ad-hoc per-company title gates.
//
// Two personas:
//   champion — feels the data/eval pain, can evaluate + route internally.
//   buyer    — owns budget + the vendor decision.
//
// Contact priority (who to email first): DATA_EVAL ▸ ROBOT_LEARNING ▸ PRODUCT
// (champions) then OPERATIONS ▸ PARTNERSHIPS ▸ FOUNDER (buyers). Lead with the
// technical champion who feels the pain; multithread to the economic buyer
// second. The buyer is the COO / partnerships lead who owns budget + vendor
// intake — NOT the CEO, except at early startups where the founder is the only
// operator (handled automatically: founders are then the sole buyer-persona).
//
// Robustness: a title matches a role when it hits a FUNCTION token AND a
// SENIORITY token. Leaders promote; senior ICs in a champion function are
// fallback-eligible (used only when a function has no leader). Empty/generic
// titles are handled upstream by the agentic role-finder (find-leads.ts), which
// names people the title signal misses.
import type { Tier } from './types.js';

export type FunctionTag =
  | 'ROBOT_LEARNING'
  | 'DATA_EVAL'
  | 'PRODUCT'
  | 'OPERATIONS'
  | 'PARTNERSHIPS'
  | 'FOUNDER';

export type Seniority = 'LEADER' | 'IC' | 'UNKNOWN';
export type Persona = 'champion' | 'buyer';

export type RoleClassification = {
  function: FunctionTag | null; // null = not a recognized target role
  seniority: Seniority;
  persona: Persona | null;
  // Higher = contact sooner. Drives ranking + committee fill.
  priorityScore: number;
  // True when a non-leader is still worth keeping as a last-resort contact
  // (senior/staff/principal IC, or any IC, in a champion function — never a
  // junior/intern). Selection uses this only when a function has no leader.
  fallbackEligible: boolean;
  label: string; // human-readable, e.g. "Robot Learning · Leader"
};

// ─── Function matchers ──────────────────────────────────────────────────
// Scanned CHAMPION-first, FOUNDER last, so a dual title like "Co-Founder & CTO"
// classifies by its functional role (ROBOT_LEARNING) rather than FOUNDER —
// the lesson from Sereact's CTO. Short tokens (ai/ml/rl/bd/cto…) are
// word-boundaried so they don't match inside other words ("email" → ai).
const FUNCTION_MATCHERS: { fn: FunctionTag; persona: Persona; re: RegExp }[] = [
  {
    fn: 'DATA_EVAL',
    persona: 'champion',
    re: /\bdata\b|dataset|teleoperation|teleop|annotation|labell?ing|\bmlops\b|ml ops|ml infrastructure|ml platform|evaluation|\bevals?\b|model eval|benchmark|data quality|synthetic data|simulation|data collection|data acquisition|data engineering|data operations/i,
  },
  {
    fn: 'ROBOT_LEARNING',
    persona: 'champion',
    re: /\brobot|robotic|manipulation|manipulator|embodied|locomotion|whole[- ]?body|autonom|perception|motion planning|control systems?|machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|reinforcement learning|\brl\b|foundation models?|applied ai|computer vision|\bvision\b|research scien|research engineer|research lead|robot learning|\bcto\b|chief technolog|chief scien|chief ai|\bcaio\b/i,
  },
  { fn: 'PRODUCT', persona: 'champion', re: /\bproduct\b|\bcpo\b|chief product/i },
  {
    fn: 'OPERATIONS',
    persona: 'buyer',
    re: /\boperations?\b|\bops\b|\bcoo\b|chief operating|chief of staff|program management|program manager|deployment|manufacturing|supply chain/i,
  },
  {
    fn: 'PARTNERSHIPS',
    persona: 'buyer',
    re: /partnership|business development|\bbd\b|alliances|ecosystem|\bcco\b|chief commercial|procurement|vendor management|sourcing|\bcommercial\b/i,
  },
  {
    fn: 'FOUNDER',
    persona: 'buyer',
    re: /\bceo\b|chief executive|founder|co-?founder|cofounder|\bpresident\b|managing director|\bowner\b/i,
  },
];

// Contact-priority base per function (higher = email first).
// Buyer bucket ranks OPERATIONS ▸ PARTNERSHIPS ▸ FOUNDER: a COO owns the ops
// budget + build-vs-buy decision, partnerships/BD owns vendor intake, and the
// founder is only the right buyer when there's NO dedicated operator — which
// happens automatically at true early-stage startups (founders are then the
// only buyer-persona people on the roster). At a scaled company a CEO is both
// the wrong owner and the hardest to reach, so FOUNDER is the fallback.
const FUNCTION_PRIORITY: Record<FunctionTag, number> = {
  DATA_EVAL: 6,
  ROBOT_LEARNING: 5,
  PRODUCT: 4,
  OPERATIONS: 3,
  PARTNERSHIPS: 2,
  FOUNDER: 1,
};

// ─── Seniority matchers ───────────────────────────────────────────────────
const LEADER_RE =
  /\bhead\b|head of|\bchief\b|\bc[teopd]o\b|\bcaio\b|\bcco\b|\bcpo\b|\bcdo\b|\bvp\b|\bsvp\b|\bevp\b|vice president|\bdirector\b|\blead\b|\bfounder\b|co-?founder|\bpresident\b|managing director|chief of staff/i;
const IC_RE =
  /\bengineer\b|\bscientist\b|\bresearcher\b|developer|\bspecialist\b|\banalyst\b|member of technical staff|\bmts\b|\bstaff\b|\bprincipal\b|\bassociate\b|\bintern\b/i;
const JUNIOR_RE = /\bintern\b|\bjunior\b|\bjr\.?\b|undergrad|\bstudent\b/i;

const seniorityOf = (title: string): Seniority => {
  if (LEADER_RE.test(title)) return 'LEADER';
  if (IC_RE.test(title)) return 'IC';
  return 'UNKNOWN';
};

// Granular seniority bonus — breaks ties between same-function leaders so a
// Chief/C-level beats a VP beats a Head beats a Director beats a Lead (e.g. a
// CCO outranks a Director of BD; both are PARTNERSHIPS leaders). Kept in 0–8 so
// it never overtakes the ×10 function priority — function still dominates.
const seniorityBonusOf = (title: string): number => {
  if (/\bchief\b|\bc[teopd]o\b|\bcaio\b|\bcco\b|\bcpo\b|\bcdo\b/.test(title)) return 8; // C-level
  if (/founder|co-?founder|\bpresident\b|managing director/.test(title)) return 7;
  if (/\bsvp\b|\bevp\b/.test(title)) return 7;
  if (/\bvp\b|vice president/.test(title)) return 6;
  if (/\bhead\b|head of/.test(title)) return 6;
  if (/\bdirector\b/.test(title)) return 5;
  if (/\blead\b|chief of staff/.test(title)) return 4;
  if (/\bprincipal\b|\bstaff\b/.test(title)) return 2; // senior IC
  if (IC_RE.test(title)) return 1;
  return 0;
};

export const classifyRole = (title: string | undefined | null): RoleClassification => {
  const none: RoleClassification = {
    function: null,
    seniority: 'UNKNOWN',
    persona: null,
    priorityScore: 0,
    fallbackEligible: false,
    label: 'Unknown',
  };
  if (!title || !title.trim()) return none;
  const lower = title.toLowerCase();

  const match = FUNCTION_MATCHERS.find((m) => m.re.test(lower));
  if (!match) return none;

  const seniority = seniorityOf(lower);
  const isJunior = JUNIOR_RE.test(lower);
  // Leaders promote; a champion-function IC is a usable fallback unless junior.
  const fallbackEligible =
    !isJunior && (seniority === 'IC' || seniority === 'UNKNOWN') && match.persona === 'champion';

  // Juniors sink below everything real.
  const priorityScore = isJunior ? 0 : FUNCTION_PRIORITY[match.fn] * 10 + seniorityBonusOf(lower);

  return {
    function: match.fn,
    seniority,
    persona: match.persona,
    priorityScore,
    fallbackEligible,
    label: `${FUNCTION_LABEL[match.fn]} · ${seniority === 'LEADER' ? 'Leader' : seniority === 'IC' ? 'IC' : 'Unknown'}`,
  };
};

const FUNCTION_LABEL: Record<FunctionTag, string> = {
  ROBOT_LEARNING: 'Robot Learning',
  DATA_EVAL: 'Data & Eval',
  PRODUCT: 'Product',
  OPERATIONS: 'Operations',
  PARTNERSHIPS: 'Partnerships',
  FOUNDER: 'Founder/Exec',
};

// Map a role onto the legacy Candidate.Tier so existing scoring/dedup keeps
// working while selection uses the richer role model. Champion leaders read as
// strong technical tiers; buyers as BUYER/FOUNDER.
export const tierForRole = (role: RoleClassification): Tier => {
  switch (role.function) {
    case 'ROBOT_LEARNING':
    case 'PRODUCT':
      return 'TECHNICAL';
    case 'DATA_EVAL':
      return 'RESEARCH_ENG';
    case 'OPERATIONS':
    case 'PARTNERSHIPS':
      return 'BUYER';
    case 'FOUNDER':
      return 'FOUNDER';
    default:
      return 'OTHER';
  }
};

// ─── Agentic search seeds ─────────────────────────────────────────────────
// Per-function web queries for the agentic role-finder. Phrased the way
// org-charts / news / press actually name these people, so neural search
// surfaces the page that names them even when their own profile is generic.
const FUNCTION_QUERY_TERMS: Record<FunctionTag, string[]> = {
  ROBOT_LEARNING: ['head of robotics', 'robotics lead', 'head of robot learning', 'head of AI', 'chief scientist'],
  DATA_EVAL: ['head of data', 'head of data collection', 'head of evaluation', 'data lead'],
  PRODUCT: ['head of product', 'VP product'],
  OPERATIONS: ['COO', 'head of operations', 'chief of staff'],
  PARTNERSHIPS: ['head of partnerships', 'business development lead'],
  FOUNDER: ['CEO', 'founder'],
};

export const roleQueries = (companyName: string, fn: FunctionTag): string[] => {
  const terms = FUNCTION_QUERY_TERMS[fn];
  // A direct "who is the X at Y" phrasing (best for neural search) plus a
  // looser "Y X" phrasing for org-chart/title pages.
  return [
    `who is the ${terms[0]} at ${companyName}`,
    ...terms.slice(0, 2).map((t) => `${companyName} ${t}`),
  ];
};

// All target functions, in contact-priority order — iterated by the agentic
// role-finder and by committee selection.
export const ALL_FUNCTIONS: FunctionTag[] = [
  'DATA_EVAL',
  'ROBOT_LEARNING',
  'PRODUCT',
  'FOUNDER',
  'OPERATIONS',
  'PARTNERSHIPS',
];
