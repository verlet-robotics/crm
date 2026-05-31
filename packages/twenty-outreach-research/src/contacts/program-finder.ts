// Program-scoped commercial Stage 2 finder.
//
// For a LARGE diversified company (Mistral, OpenAI, Google DeepMind) where the
// thing we sell into is a specific PROGRAM — robotics — not the whole org. The
// normal commercial finder fails here: the robotics researchers are <5% of
// headcount, often share a flat title ("Member of Technical Staff"), and get
// out-ranked by loud senior execs. The signal that actually identifies a
// robotics person is their CONTENT — what they publish and what they say they
// work on — not their title or mere employment at the company.
//
// Sources (all gated to the program, not just the company):
//   1. Exa LinkedIn — robotics keywords + company name. Finds people who SAY
//      they do robotics at this company. Primary recall signal.
//   2. S2 lead co-author expansion (when a --lead is known) — walks one hop out
//      from a known program lead to their co-authors, keeping those who
//      co-author repeatedly or whose S2 affiliation matches the company.
//      Catches the publishing roboticists hidden behind flat titles.
//   3. Firecrawl program page (when --program-url given) — scrape a research /
//      team page that lists the program's members.
//   4. Apollo — robotics keywords as the title filter. Weak when titles are
//      flat, but free recall where titles DO say "Robotics".
//
// Content gate: a candidate is kept only with a program signal — a robotics
// keyword in their title or profile snippet, OR provenance that already implies
// it (S2 co-author of the lead, or listed on the program page). This is what
// stops the finder from confidently returning the CEO and three random execs.
import { enrichPersonById, searchPeopleAtCompany } from '../discover/apollo.js';
import { extractTeamPage } from '../research/scrapers/firecrawl.js';
import { searchLinkedInProfiles } from '../research/scrapers/exa.js';
import {
  fetchAuthorAffiliations,
  fetchRecentPapersWithCoauthors,
  findAuthor,
} from '../research/scrapers/papers.js';

import {
  COMMERCIAL_TEAM_PATHS,
  candidateKey,
  classifyTier,
  dedupCandidates,
  fromApollo,
  fromLinkedIn,
  fromS2Coauthor,
  fromTeamMember,
  probeTeamPages,
  settled,
  sleep,
} from './shared.js';
import type { FinderResult } from './commercial-finder.js';
import type { Candidate, FinderTarget, Tier } from './types.js';

type ProgramOptions = {
  skipApollo?: boolean;
  skipFirecrawl?: boolean;
  skipExa?: boolean;
  skipS2?: boolean;
  papersForLead?: number;
};

// Default robotics keywords — drive both the Exa/Apollo SEARCH (recall) and the
// content GATE (precision). Override with --program="a,b,c" for an adjacent
// program (e.g. autonomous driving, drones).
export const DEFAULT_PROGRAM_KEYWORDS = [
  'robotics',
  'robot learning',
  'manipulation',
  'embodied AI',
  'humanoid',
  'locomotion',
  'teleoperation',
  'dexterous',
  'vision-language-action',
];

// Built-in robotics signal — always part of the gate regardless of the
// keyword list, kept robotics-specific so it does NOT match generic LLM/ML
// work (no bare "machine learning" / "reinforcement learning", which would let
// every pretraining researcher through). Word-stems so "manipulation" /
// "manipulator" both hit.
const ROBOTICS_SIGNAL_RE =
  /robot|manipulat|embodi|humanoid|locomotion|teleop|sim-to-real|sim2real|dexter|grasp|legged|quadruped|vision-language-action|\bvla\b|end-effector|propriocept|whole-body|mobile manipulation|motor control|tactile/i;

// Build the content gate: a text passes if it hits the built-in robotics regex
// OR any of the (possibly customized) program keywords.
const buildGate = (keywords: string[]): ((text: string) => boolean) => {
  const escaped = keywords.map((k) => k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const kwRe = escaped.length ? new RegExp(escaped.join('|'), 'i') : null;
  return (text: string) => ROBOTICS_SIGNAL_RE.test(text) || (!!kwRe && kwRe.test(text));
};

const signalText = (c: Candidate): string => `${c.title ?? ''} ${c.rawNotes.join(' ')}`;

// Company-affiliation matchers for S2 cross-ref: the company name + the
// domain's first dotted segment (mistral.ai → "mistral"), all lowercased.
const companyAffiliationMatchers = (target: FinderTarget): string[] => {
  const segment = target.domain.split('.')[0]?.toLowerCase();
  return [target.name.toLowerCase(), ...(segment ? [segment] : [])].filter(Boolean);
};

const tierRank: Record<string, number> = { PI: 3, PHD_STUDENT: 2, POSTDOC: 1 };
const tierFromAuthorPosition = (index: number, totalAuthors: number): Tier => {
  if (totalAuthors === 1) return 'PI';
  if (index === totalAuthors - 1) return 'PI';
  if (index === 0) return 'PHD_STUDENT';
  return 'POSTDOC';
};

// Resolve the program lead in S2, then pull their recent papers with co-authors.
const resolveLeadCoauthors = async (leadName: string, companyName: string, limit: number) => {
  const lead = await findAuthor(leadName, companyName);
  if (!lead) {
    console.warn(`[stage2:contacts] S2 could not find lead "${leadName}" at "${companyName}"`);
    return [];
  }
  console.log(`[stage2:contacts] S2 lead resolved: ${lead.name} (id=${lead.authorId})`);
  return fetchRecentPapersWithCoauthors(lead.authorId, limit);
};

export const findProgramContacts = async (
  target: FinderTarget,
  opts: ProgramOptions = {},
): Promise<FinderResult> => {
  const keywords = target.programKeywords?.length ? target.programKeywords : DEFAULT_PROGRAM_KEYWORDS;
  const gate = buildGate(keywords);
  const stats: FinderResult['stats'] = {
    apolloHits: 0,
    firecrawlHits: 0,
    exaHits: 0,
    s2Hits: 0,
    beforeDedup: 0,
    afterDedup: 0,
  };

  const [apolloResult, teamResult, linkedinResult, papersResult] = await Promise.all([
    opts.skipApollo
      ? Promise.resolve(null)
      : settled('apollo-program', searchPeopleAtCompany(target.domain, keywords, 25)),
    opts.skipFirecrawl || !target.labUrl
      ? Promise.resolve(null)
      : settled('firecrawl-program', probeTeamPages(target.domain, target.labUrl, COMMERCIAL_TEAM_PATHS, extractTeamPage)),
    opts.skipExa
      ? Promise.resolve(null)
      : settled('exa-program', searchLinkedInProfiles(target.name, keywords, 25)),
    opts.skipS2 || !target.piName
      ? Promise.resolve(null)
      : settled('s2-lead', resolveLeadCoauthors(target.piName, target.name, opts.papersForLead ?? 10)),
  ]);

  // ─── Gated sources (must pass the content gate) — Apollo + Exa LinkedIn ───
  const gated: Candidate[] = [];
  if (apolloResult) {
    for (const p of apolloResult) {
      const c = fromApollo(p);
      if (c) {
        gated.push(c);
        stats.apolloHits += 1;
      }
    }
  }
  if (linkedinResult) {
    for (const h of linkedinResult) {
      const c = fromLinkedIn(h);
      if (c) {
        gated.push(c);
        stats.exaHits += 1;
      }
    }
  }

  // ─── Trusted-by-provenance sources — program page + S2 lead co-authors ───
  // These are kept WITHOUT the content gate: a person listed on the robotics
  // program page, or who repeatedly co-authors robotics papers with the lead,
  // is on the program by construction even if their title/snippet is generic.
  const trusted: Candidate[] = [];
  const trustedKeys = new Set<string>();

  if (teamResult?.members) {
    for (const m of teamResult.members) {
      const c = fromTeamMember(m);
      if (c) {
        if (!c.title) c.defaultTier = 'RESEARCH_ENG';
        trusted.push(c);
        trustedKeys.add(candidateKey(c));
        stats.firecrawlHits += 1;
      }
    }
  }

  // S2 lead co-authors: bucket by co-authorship frequency. paperCount>=2 is
  // trusted immediately (a real teammate co-authors repeatedly); paperCount==1
  // is held for an affiliation cross-ref below (most one-off co-authors are
  // external collaborators at other orgs).
  const s2OneOff: Candidate[] = [];
  if (papersResult) {
    type Bucket = { author: { name: string; authorId?: string }; paperCount: number; bestTier: Tier; hint: string };
    const buckets = new Map<string, Bucket>();
    for (const paper of papersResult) {
      const total = paper.authors.length;
      paper.authors.forEach((author, idx) => {
        const tier = tierFromAuthorPosition(idx, total);
        const key = author.name.toLowerCase().trim();
        const existing = buckets.get(key);
        if (existing) {
          existing.paperCount += 1;
          if ((tierRank[tier] ?? 0) > (tierRank[existing.bestTier] ?? 0)) existing.bestTier = tier;
        } else {
          buckets.set(key, {
            author,
            paperCount: 1,
            bestTier: tier,
            hint: `${paper.title.slice(0, 50)} (${paper.year})`,
          });
        }
      });
    }
    for (const b of buckets.values()) {
      const hint = b.paperCount > 1 ? `${b.hint} +${b.paperCount - 1} more` : b.hint;
      if (b.paperCount >= 2) {
        const c = fromS2Coauthor(b.author, b.bestTier, hint, b.paperCount);
        if (c) {
          trusted.push(c);
          trustedKeys.add(candidateKey(c));
          stats.s2Hits += 1;
        }
      } else {
        // Hold one-offs for affiliation cross-ref; stash inferredTier so we can
        // keep them at their position-tier if the company affiliation confirms.
        const c = fromS2Coauthor(b.author, 'OTHER', hint, 1);
        if (c) {
          c.inferredTier = b.bestTier;
          s2OneOff.push(c);
        }
      }
    }
  }

  // S2 one-off affiliation cross-ref — keep only those whose S2 affiliation
  // names the company (a robotics co-author actually employed here), drop the
  // external academics. Bounded + stops on rate-limit.
  if (s2OneOff.length > 0) {
    const matchers = companyAffiliationMatchers(target);
    let checked = 0;
    let kept = 0;
    for (const c of s2OneOff.slice(0, 30)) {
      if (!c.s2AuthorId) continue;
      const affs = await fetchAuthorAffiliations(c.s2AuthorId);
      if (affs === null) break; // rate-limited — stop.
      checked += 1;
      const hay = affs.join(' ').toLowerCase();
      if (affs.length > 0 && matchers.some((m) => hay.includes(m))) {
        c.defaultTier = c.inferredTier ?? 'RESEARCH_ENG';
        c.rawNotes.push(`S2 affiliation match: ${affs.slice(0, 2).join('; ')}`);
        trusted.push(c);
        trustedKeys.add(candidateKey(c));
        stats.s2Hits += 1;
        kept += 1;
      }
      await sleep(150);
    }
    if (checked > 0) console.log(`[stage2:contacts] S2 one-off cross-ref: ${kept} kept of ${checked} checked`);
  }

  // ─── Merge, gate, and normalize tiers ───────────────────────────────────
  const raw = [...trusted, ...gated];
  stats.beforeDedup = raw.length;
  const deduped = dedupCandidates(raw);

  // Keep a candidate if it's trusted-by-provenance OR passes the content gate.
  const kept = deduped.filter((c) => trustedKeys.has(candidateKey(c)) || gate(signalText(c)));
  const dropped = deduped.length - kept.length;
  if (dropped > 0) {
    console.log(`[stage2:contacts] program gate dropped ${dropped} non-robotics candidate(s)`);
  }

  // Every kept candidate is a robotics person — make sure none score as OTHER
  // (which would sink them below noise). Default the unclassifiable ones to
  // RESEARCH_ENG so downstream scoring + selection treats them as technical.
  for (const c of kept) {
    if (classifyTier(c.title, c.defaultTier) === 'OTHER') c.defaultTier = 'RESEARCH_ENG';
  }

  // Apollo enrichment — unlock the obfuscated last_name + email on kept Apollo
  // candidates. Done AFTER the gate (unlike the commercial finder, which
  // enriches a pre-gate top-N) so we only spend Apollo credits on confirmed
  // robotics people. Without this the commit step drops them (no last name).
  if (!opts.skipApollo) {
    let unlocked = 0;
    for (const c of kept) {
      if (!c.apolloId || (c.lastName && c.email)) continue;
      const enriched = await enrichPersonById(c.apolloId, {
        firstName: c.firstName,
        organizationDomain: target.domain,
      });
      if (!enriched) continue;
      if (enriched.lastName) c.lastName = enriched.lastName;
      if (enriched.email && !c.email) {
        c.email = enriched.email;
        c.sources.add('apollo');
      }
      if (enriched.linkedinUrl && !c.linkedinUrl) c.linkedinUrl = enriched.linkedinUrl;
      unlocked += 1;
      await sleep(250);
    }
    if (unlocked > 0) console.log(`[stage2:contacts] apollo enriched ${unlocked} program candidates`);
  }

  // Re-dedup after enrichment: unlocking an Apollo last_name can reveal a
  // collision with an Exa/Firecrawl candidate that was distinct while the
  // Apollo name was still masked (e.g. "Elliot ∅" + "Elliot Chane-Sane").
  const remerged = dedupCandidates(kept);
  stats.afterDedup = remerged.length;
  return { candidates: remerged, stats };
};
