// Academic Stage 2 finder. For accountType=INSTITUTION.
//
// Different sources from commercial because Apollo coverage on academia is
// sparse (.edu emails behind privacy walls, students rarely in Apollo's index)
// and lab webpages publish rosters that commercial /team probes miss.
//
// Parallel fanout across three sources:
//   1. Firecrawl lab-roster extract — probes academic subpaths (/people,
//      /members, /group/members, etc.). This is the primary signal for grad
//      students + postdocs.
//   2. S2 co-author expansion — looks up the PI by name+affiliation, pulls
//      recent papers WITH authors, filters co-authors whose affiliations match
//      the target institution. Fills gaps when lab websites are outdated.
//      Tier is inferred from paper position: first-author → PHD_STUDENT,
//      last-author → PI, middle → POSTDOC.
//   3. Exa LinkedIn profile search with academic title keywords —
//      cross-reference for role labels on S2-discovered candidates.
//
// Explicitly NOT used: Apollo (coverage gap + credit conservation).
import { fetchAuthorAffiliations, findAuthor, fetchRecentPapersWithCoauthors } from '../research/scrapers/papers.js';
import { extractTeamPage } from '../research/scrapers/firecrawl.js';
import { searchLinkedInProfiles } from '../research/scrapers/exa.js';
import { INSTITUTION_ALLOWLIST } from '../discover/sources.js';

import {
  ACADEMIC_TEAM_PATHS,
  ACADEMIC_TITLES,
  candidateKey,
  dedupCandidates,
  fromLinkedIn,
  fromS2Coauthor,
  fromTeamMember,
  probeTeamPages,
  settled,
  sleep,
} from './shared.js';
import type { FinderResult } from './commercial-finder.js';
import type { Candidate, FinderTarget, Tier } from './types.js';

type AcademicOptions = {
  skipFirecrawl?: boolean;
  skipS2?: boolean;
  skipExa?: boolean;
  papersPerPI?: number;
};

// Build affiliation match strings for the target institution. Uses
// INSTITUTION_ALLOWLIST matchers when available so e.g. "MIT CSAIL" +
// "Massachusetts Institute of Technology" both resolve to MIT. Otherwise
// falls back to the target name + the domain's first dotted segment
// (utexas.edu → "utexas"). All values lowercased for case-insensitive match.
const buildAffiliationMatchers = (target: FinderTarget): string[] => {
  const row = INSTITUTION_ALLOWLIST.find((i) => i.domain === target.domain);
  if (row) return [...row.matchers, row.name.toLowerCase()].map((s) => s.toLowerCase());
  return [target.name.toLowerCase(), target.domain.split('.')[0]];
};

// Infer tier from author position within a paper. Heuristics:
//   - Single-author paper: PI
//   - Last author: PI (senior author convention)
//   - First author: PHD_STUDENT (most common in robotics/ML)
//   - Middle authors: POSTDOC (default — could be PhD too; lab roster will refine if both sources hit)
const tierFromAuthorPosition = (index: number, totalAuthors: number): Tier => {
  if (totalAuthors === 1) return 'PI';
  if (index === totalAuthors - 1) return 'PI';
  if (index === 0) return 'PHD_STUDENT';
  return 'POSTDOC';
};

export const findAcademicContacts = async (
  target: FinderTarget,
  opts: AcademicOptions = {},
): Promise<FinderResult> => {
  const stats: FinderResult['stats'] = {
    apolloHits: 0,
    firecrawlHits: 0,
    exaHits: 0,
    s2Hits: 0,
    beforeDedup: 0,
    afterDedup: 0,
  };

  const [teamResult, papersResult, linkedinResult] = await Promise.all([
    opts.skipFirecrawl
      ? Promise.resolve(null)
      : settled('firecrawl-lab', probeTeamPages(target.domain, target.labUrl, ACADEMIC_TEAM_PATHS, extractTeamPage)),
    opts.skipS2 || !target.piName
      ? Promise.resolve(null)
      : settled('s2-pi-coauthors', resolvePiCoauthors(target.piName, target.name, opts.papersPerPI ?? 8)),
    opts.skipExa
      ? Promise.resolve(null)
      : settled('exa-linkedin', searchLinkedInProfiles(target.name, ACADEMIC_TITLES, 15)),
  ]);

  const raw: Candidate[] = [];

  if (teamResult?.members) {
    for (const m of teamResult.members) {
      const c = fromTeamMember(m);
      if (c) {
        // For academic candidates without a parsed title, default to PHD_STUDENT.
        // Lab rosters usually list students with no title or just a name.
        if (!c.title) c.defaultTier = 'PHD_STUDENT';
        raw.push(c);
        stats.firecrawlHits += 1;
      }
    }
  }

  // Collect S2 co-authors with frequency count. Affiliation data isn't
  // available from /author/{id}/papers (S2 API limitation), so we cast a
  // wide net and rely on lab-roster dedup to confirm real lab members.
  // Co-authors who appear on multiple PI papers (count >= 2) are very likely
  // current lab members; one-off co-authors are external collaborators.
  if (papersResult) {
    type S2Bucket = {
      author: { name: string; authorId?: string };
      paperCount: number;
      bestTier: Tier; // strongest tier seen across all papers
      paperHint: string;
    };
    // Tier rank for "strongest signal": PI (senior-author) > PHD_STUDENT (lead-author)
    // > POSTDOC (middle-author). Higher = more discriminative position.
    const tierRank: Record<string, number> = { PI: 3, PHD_STUDENT: 2, POSTDOC: 1 };
    const s2Buckets = new Map<string, S2Bucket>();
    for (const paper of papersResult) {
      const total = paper.authors.length;
      paper.authors.forEach((author, idx) => {
        const tier = tierFromAuthorPosition(idx, total);
        const key = author.name.toLowerCase().trim();
        const existing = s2Buckets.get(key);
        if (existing) {
          existing.paperCount += 1;
          if ((tierRank[tier] ?? 0) > (tierRank[existing.bestTier] ?? 0)) {
            existing.bestTier = tier;
          }
        } else {
          s2Buckets.set(key, {
            author,
            paperCount: 1,
            bestTier: tier,
            paperHint: `${paper.title.slice(0, 50)} (${paper.year})`,
          });
        }
      });
    }
    for (const bucket of s2Buckets.values()) {
      // Start strict: paperCount=1 is likely external → tier=OTHER. The S2
      // affiliation cross-ref pass below can UPGRADE back to bestTier if it
      // confirms the author is at the target institution. This biases toward
      // recall of real lab members (>=2 papers) and conservatism on one-offs.
      const tier = bucket.paperCount >= 2 ? bucket.bestTier : 'OTHER';
      const hint = bucket.paperCount > 1
        ? `${bucket.paperHint} +${bucket.paperCount - 1} more`
        : bucket.paperHint;
      const c = fromS2Coauthor(bucket.author, tier, hint, bucket.paperCount);
      if (c) {
        // Stash the position-inferred tier so the cross-ref pass can restore
        // it when affiliation confirms the author is at the target institution.
        c.inferredTier = bucket.bestTier;
        raw.push(c);
        stats.s2Hits += 1;
      }
    }
  }

  // Exa in academic mode is ENRICHMENT-ONLY — discovery via Exa is too noisy
  // (a search for "Professor UT Austin site:linkedin.com/in" returns every UT
  // prof, not RPL Lab members). Only keep Exa hits whose names also appear in
  // Firecrawl or S2 results; use them to enrich title + linkedinUrl on the
  // already-discovered candidate.
  stats.beforeDedup = raw.length;
  let cands = dedupCandidates(raw);

  // ─── S2 affiliation cross-ref (UPGRADE-ONLY) ──────────────────────
  // S2 candidates currently in OTHER tier (paperCount=1, demoted because most
  // one-off co-authors are external). Look up /author/{id}?fields=affiliations
  // to confirm or refute. Behavior:
  //   - affiliation matches target → restore inferredTier (recovered lab member)
  //   - affiliation explicit mismatch → leave as OTHER + log
  //   - no affiliation data (sparse S2) → leave as OTHER (no upgrade)
  //
  // We never DOWNGRADE here. Cands already at PI/POSTDOC/PHD_STUDENT
  // (paperCount>=2 signal) are trusted regardless of S2 affiliation gaps.
  const affMatchers = buildAffiliationMatchers(target);
  const otherWithS2 = cands
    .filter((c) => c.defaultTier === 'OTHER' && c.s2AuthorId && c.inferredTier)
    .sort((a, b) => (b.paperCount ?? 0) - (a.paperCount ?? 0));
  let crossRefd = 0;
  let crossRefUpgrades = 0;
  let crossRefMismatches = 0;
  for (const c of otherWithS2.slice(0, 40)) {
    const affs = await fetchAuthorAffiliations(c.s2AuthorId!);
    if (affs === null) break; // rate-limited; stop cross-ref pass.
    c.s2Affiliations = affs.map((a) => a.toLowerCase());
    crossRefd += 1;
    if (c.s2Affiliations.length === 0) {
      // No data — stay at OTHER. (Half of S2 authors lack affiliations.)
      await sleep(150);
      continue;
    }
    const hay = c.s2Affiliations.join(' ');
    if (affMatchers.some((m) => hay.includes(m))) {
      // Confirmed lab member — restore the position-inferred tier.
      c.defaultTier = c.inferredTier!;
      c.rawNotes.push(`S2 affiliation match: ${affs.slice(0, 2).join('; ')}`);
      crossRefUpgrades += 1;
    } else {
      // S2 explicitly says elsewhere — Ken Goldberg → UC Berkeley etc.
      c.rawNotes.push(`S2 affiliation mismatch: ${affs.slice(0, 2).join('; ')}`);
      crossRefMismatches += 1;
    }
    await sleep(150);
  }
  if (crossRefd > 0) {
    console.log(
      `[stage2:contacts] S2 affiliation cross-ref: ${crossRefUpgrades} restored, ${crossRefMismatches} mismatched, ${crossRefd - crossRefUpgrades - crossRefMismatches} unknown (of ${crossRefd} checked)`,
    );
  }

  if (linkedinResult && linkedinResult.length > 0) {
    const known = new Set(cands.map((c) => candidateKey(c)));
    let enriched = 0;
    let kept = 0;
    for (const h of linkedinResult) {
      const c = fromLinkedIn(h);
      if (!c) continue;
      const key = candidateKey(c);
      if (!known.has(key)) continue;
      // Merge: add linkedinUrl + title to the existing candidate if missing.
      const existing = cands.find((x) => candidateKey(x) === key);
      if (!existing) continue;
      if (!existing.linkedinUrl && c.linkedinUrl) existing.linkedinUrl = c.linkedinUrl;
      if (!existing.title && c.title) existing.title = c.title;
      existing.sources.add('exa');
      existing.rawNotes.push(...c.rawNotes);
      enriched += 1;
      kept += 1;
    }
    stats.exaHits = kept;
    if (enriched > 0) console.log(`[stage2:contacts] exa cross-ref enriched ${enriched} academic candidates`);
  }

  stats.afterDedup = cands.length;
  return { candidates: cands, stats };
};

// Find PI in S2 then pull recent papers with authors. Returns [] when the PI
// can't be disambiguated — common for short PI names, in which case lab
// roster + Exa still produce candidates.
const resolvePiCoauthors = async (
  piName: string,
  affiliationHint: string,
  limit: number,
) => {
  const pi = await findAuthor(piName, affiliationHint);
  if (!pi) {
    console.warn(`[stage2:contacts] S2 could not find PI "${piName}" at "${affiliationHint}"`);
    return [];
  }
  console.log(`[stage2:contacts] S2 PI resolved: ${pi.name} (id=${pi.authorId})`);
  return fetchRecentPapersWithCoauthors(pi.authorId, limit);
};
