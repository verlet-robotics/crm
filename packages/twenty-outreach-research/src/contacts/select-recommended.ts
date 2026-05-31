// For a commercial company, pick WHO to reach out to from its existing roster:
// the top business/buyer contacts and top technical/champion contacts, using
// the canonical role taxonomy (role-taxonomy.ts) as the single source of truth.
//
// Champion persona → technical bucket; buyer persona → business bucket. Within
// the technical bucket we prefer LEADERS and fall back to a standout senior IC
// only when no leader exists (the chosen rule). Business picks get a light
// role-angle from the company brief; technical picks get full per-person
// research (run-for-company auto-runs that). Pure function over the company's
// already-discovered People — no scraping, no LLM.
import { classifyRole, tierForRole, type FunctionTag } from './role-taxonomy.js';
import { canonicalFirstName, normName } from './shared.js';
import type { Tier } from './types.js';

export type CompanyPerson = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  email?: string | null;
  researchStatus?: string | null;
};

export type OutreachRole =
  | 'BUSINESS_PRIMARY'
  | 'BUSINESS_BACKUP'
  | 'TECHNICAL_PRIMARY'
  | 'TECHNICAL_BACKUP';

export type RecommendedContact = CompanyPerson & {
  tier: Tier;
  bucket: 'business' | 'technical';
  outreachRole: OutreachRole;
  score: number;
};

export type Recommendation = {
  business: RecommendedContact[];
  technical: RecommendedContact[];
};

// An on-file email is a meaningful tiebreaker (you can actually reach them) but
// must not outweigh role priority — keep it small relative to priorityScore
// (which is ~10–65).
const scoreFor = (priorityScore: number, hasEmail: boolean): number =>
  priorityScore + (hasEmail ? 5 : 0);

const roleFor = (bucket: 'business' | 'technical', index: number): OutreachRole =>
  bucket === 'business'
    ? index === 0
      ? 'BUSINESS_PRIMARY'
      : 'BUSINESS_BACKUP'
    : index === 0
      ? 'TECHNICAL_PRIMARY'
      : 'TECHNICAL_BACKUP';

type Scored = {
  person: CompanyPerson;
  fn: FunctionTag;
  tier: Tier;
  bucket: 'business' | 'technical';
  isLeader: boolean;
  fallbackEligible: boolean;
  score: number;
};

export const selectRecommendedContacts = (
  people: CompanyPerson[],
  opts: { perBucket?: number; perTechnical?: number; perBusiness?: number } = {},
): Recommendation => {
  // Technical picks trigger paid deep-research downstream → keep tight (2).
  // Business picks only get a light role-hook → include more (3) so we can
  // multithread across the COO + commercial leaders.
  const perTechnical = opts.perTechnical ?? opts.perBucket ?? 2;
  const perBusiness = opts.perBusiness ?? opts.perBucket ?? 3;

  const scored: Scored[] = people
    .map((person): Scored | null => {
      const role = classifyRole(person.jobTitle);
      if (!role.function || !role.persona) return null; // not a recognized target
      return {
        person,
        fn: role.function,
        tier: tierForRole(role),
        bucket: role.persona === 'champion' ? 'technical' : 'business',
        isLeader: role.seniority === 'LEADER',
        fallbackEligible: role.fallbackEligible,
        score: scoreFor(role.priorityScore, !!person.email),
      };
    })
    .filter((x): x is Scored => x !== null)
    .sort((a, b) => b.score - a.score);

  // Dedup same-person records by nickname-aware name key (e.g. "Nick Paine" +
  // "Nicholas Paine", which have different on-file emails so email-dedup misses
  // them). Keep the higher-scored record (list is score-sorted).
  const ranked: Scored[] = [];
  const seenName = new Set<string>();
  for (const x of scored) {
    const key = `${canonicalFirstName(x.person.firstName ?? '')} ${normName(x.person.lastName ?? '')}`;
    if (seenName.has(key)) continue;
    seenName.add(key);
    ranked.push(x);
  }

  // Diversity-preferring order: best of each distinct function first (pool is
  // already score-sorted), then the leftovers by score. Spreads the buyer slots
  // across functions (COO + commercial) instead of stacking two of one.
  const diversityOrder = (pool: Scored[]): Scored[] => {
    const used = new Set<FunctionTag>();
    const first: Scored[] = [];
    const rest: Scored[] = [];
    for (const x of pool) {
      if (used.has(x.fn)) {
        rest.push(x);
      } else {
        used.add(x.fn);
        first.push(x);
      }
    }
    return [...first, ...rest];
  };

  // Technical (champion): best champions by score, same function allowed (CTO +
  // Autonomy Lead are both worth having); top up with a fallback IC if no leader.
  const pickTechnical = (): Scored[] => {
    const inBucket = ranked.filter((x) => x.bucket === 'technical');
    const leaders = inBucket.filter((x) => x.isLeader);
    const fallback = inBucket.filter((x) => !x.isLeader && x.fallbackEligible);
    return [...leaders, ...fallback].slice(0, perTechnical);
  };

  // Business (buyer): fill from real operators (OPERATIONS/PARTNERSHIPS leaders),
  // diversity-preferring; FOUNDER is a fallback used only when there aren't
  // enough operators (true early startups where the founder IS the buyer).
  const pickBusiness = (): Scored[] => {
    const leaders = ranked.filter((x) => x.bucket === 'business' && x.isLeader);
    const operators = diversityOrder(leaders.filter((x) => x.fn !== 'FOUNDER'));
    const founders = leaders.filter((x) => x.fn === 'FOUNDER');
    const chosen = operators.slice(0, perBusiness);
    if (chosen.length < perBusiness) chosen.push(...founders.slice(0, perBusiness - chosen.length));
    return chosen;
  };

  const toContacts = (chosen: Scored[], bucket: 'business' | 'technical'): RecommendedContact[] =>
    chosen.map(
      (x, i): RecommendedContact => ({
        ...x.person,
        tier: x.tier,
        bucket,
        score: x.score,
        outreachRole: roleFor(bucket, i),
      }),
    );

  return {
    business: toContacts(pickBusiness(), 'business'),
    technical: toContacts(pickTechnical(), 'technical'),
  };
};
