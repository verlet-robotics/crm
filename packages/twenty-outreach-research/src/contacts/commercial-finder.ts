// Commercial Stage 2 finder. For accountType=COMPANY or LAB.
//
// Parallel fanout across three sources:
//   1. Apollo people search (followed by per-candidate enrichPersonById to
//      unlock obfuscated last_name + email on top scorers)
//   2. Firecrawl /team page extract (probes common commercial subpaths)
//   3. Exa LinkedIn profile search (post-filtered by company name)
//
// Returns Candidate[] already deduped + Apollo-enriched. Hunter enrichment +
// scoring + balance + Twenty commit happen in find-contacts.ts.
import { enrichPersonById, searchPeopleAtCompany } from '../discover/apollo.js';
import { extractTeamPage } from '../research/scrapers/firecrawl.js';
import { searchLinkedInProfiles } from '../research/scrapers/exa.js';

import {
  COMMERCIAL_TEAM_PATHS,
  candidateKey,
  dedupCandidates,
  fromApollo,
  fromLinkedIn,
  fromTeamMember,
  merge,
  probeTeamPages,
  scoreCandidate,
  settled,
  sleep,
} from './shared.js';
import type { Candidate, FinderTarget } from './types.js';

type CommercialOptions = {
  skipApollo?: boolean;
  skipFirecrawl?: boolean;
  skipExa?: boolean;
  enrichTopN?: number;
};

export type FinderStats = {
  apolloHits: number;
  firecrawlHits: number;
  exaHits: number;
  s2Hits: number;
  beforeDedup: number;
  afterDedup: number;
};

export type FinderResult = { candidates: Candidate[]; stats: FinderStats };

export const findCommercialContacts = async (
  target: FinderTarget,
  opts: CommercialOptions = {},
): Promise<FinderResult> => {
  const stats: FinderStats = {
    apolloHits: 0,
    firecrawlHits: 0,
    exaHits: 0,
    s2Hits: 0,
    beforeDedup: 0,
    afterDedup: 0,
  };

  const [apolloResult, teamResult, linkedinResult] = await Promise.all([
    opts.skipApollo
      ? Promise.resolve(null)
      : settled('apollo', searchPeopleAtCompany(target.domain, target.titleKeywords, 25)),
    opts.skipFirecrawl
      ? Promise.resolve(null)
      : settled('firecrawl', probeTeamPages(target.domain, target.labUrl, COMMERCIAL_TEAM_PATHS, extractTeamPage)),
    opts.skipExa
      ? Promise.resolve(null)
      : settled('exa', searchLinkedInProfiles(target.name, target.titleKeywords, 15)),
  ]);

  const raw: Candidate[] = [];
  if (apolloResult) {
    for (const p of apolloResult) {
      const c = fromApollo(p);
      if (c) {
        raw.push(c);
        stats.apolloHits += 1;
      }
    }
  }
  if (teamResult?.members) {
    for (const m of teamResult.members) {
      const c = fromTeamMember(m);
      if (c) {
        raw.push(c);
        stats.firecrawlHits += 1;
      }
    }
  }
  if (linkedinResult) {
    for (const h of linkedinResult) {
      const c = fromLinkedIn(h);
      if (c) {
        raw.push(c);
        stats.exaHits += 1;
      }
    }
  }
  stats.beforeDedup = raw.length;

  let cands = dedupCandidates(raw);

  // Apollo enrichment — unlock obfuscated last_name + email on top scorers
  // (Apollo Basic plan: 1 credit per enrich, ~2,500/month budget). Cap at the
  // top `enrichTopN` (default 10) so spend matches what we'd actually upsert.
  if (!opts.skipApollo) {
    cands.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const enrichLimit = opts.enrichTopN ?? 10;
    let unlocked = 0;
    for (const c of cands.slice(0, enrichLimit)) {
      if (!c.apolloId) continue;
      if (c.lastName && c.email) continue;
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
    if (unlocked > 0) console.log(`[stage2:contacts] apollo enriched ${unlocked} candidates`);

    // Re-dedup after enrichment in case last_name unlock merged previously
    // distinct candidates (e.g. Hunter "J. Smith" + Apollo "Jane S***h" both
    // become "Jane Smith").
    const remerged = new Map<string, Candidate>();
    for (const c of cands) {
      const key = candidateKey(c);
      const existing = remerged.get(key);
      remerged.set(key, existing ? merge(existing, c) : c);
    }
    cands = [...remerged.values()];
  }

  stats.afterDedup = cands.length;
  return { candidates: cands, stats };
};
