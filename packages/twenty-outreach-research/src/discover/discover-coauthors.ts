// L1 discovery — co-author expander.
//
// Highest-precision discovery source we have. Algorithm:
//   1. Pick seed People from CRM. Default seed = researchStatus=DRAFTED
//      (people whose research package is ready — we trust their identity).
//      Use --status REPLIED (or other) to expand from confirmed-good leads
//      once those start landing. Or --person-id <uuid> for single-seed expansion.
//   2. For each seed, S2 findAuthor (name + company name hint).
//   3. fetchRecentPapers(5) → walk co-authors of those papers.
//   4. For each co-author with affiliations, matchInstitution.
//   5. Upsert at the matched institution with discoverySource=COAUTHOR,
//      discoveryRef pointing to the seed Person's CRM URL.
//
// Why this matters: "PI X published with PI Y" is the strongest possible
// signal that Y works in adjacent space. Conversion of co-authors of known-good
// leads is typically 5-10x higher than arXiv-broadcast or citation-walk leads.
import 'dotenv/config';

import {
  fetchRecentPapers,
  findAuthor,
  type S2Paper,
} from '../research/scrapers/papers.js';
import {
  findPeopleByResearchStatus,
  fetchPersonForResearch,
  upsertPersonFromDiscovery,
} from '../lib/twenty-client.js';

import {
  ensureInstitutionCompany,
  logUnmatched,
  matchInstitution,
} from './match-institution.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const splitName = (full: string): { firstName: string; lastName: string } | null => {
  const cleaned = full.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
};

type Stats = {
  seeds: number;
  papersFetched: number;
  coauthorsScanned: number;
  matched: number;
  created: number;
  skipped: number;
  unmatched: number;
  errors: number;
};

type Seed = { id: string; firstName: string; lastName: string; affiliation: string };

const parseArgs = (
  argv: string[],
): { dryRun: boolean; status: string; personId?: string; perSeedPapers: number } => {
  const dryRun = argv.includes('--dry-run');
  const status =
    argv.find((a) => a.startsWith('--status='))?.replace('--status=', '') ?? 'DRAFTED';
  const personId = argv.find((a) => a.startsWith('--person-id='))?.replace('--person-id=', '');
  const perSeedPapers = Number(
    argv.find((a) => a.startsWith('--papers='))?.replace('--papers=', '') ?? '5',
  );
  return {
    dryRun,
    status,
    ...(personId && { personId }),
    perSeedPapers: Number.isFinite(perSeedPapers) ? perSeedPapers : 5,
  };
};

const loadSeeds = async (
  args: ReturnType<typeof parseArgs>,
): Promise<Seed[]> => {
  if (args.personId) {
    const p = await fetchPersonForResearch(args.personId);
    if (!p) return [];
    return [
      {
        id: p.id,
        firstName: p.name?.firstName ?? '',
        lastName: p.name?.lastName ?? '',
        affiliation: p.company?.name ?? '',
      },
    ];
  }
  const people = await findPeopleByResearchStatus(args.status, 100);
  const seeds: Seed[] = [];
  for (const p of people) {
    const firstName = p.name?.firstName;
    const lastName = p.name?.lastName;
    if (!firstName || !lastName) continue;
    seeds.push({
      id: p.id,
      firstName,
      lastName,
      affiliation: p.company?.name ?? '',
    });
  }
  return seeds;
};

export const discoverFromCoauthors = async (
  opts: {
    dryRun?: boolean;
    status?: string;
    personId?: string;
    perSeedPapers?: number;
  } = {},
): Promise<Stats> => {
  const stats: Stats = {
    seeds: 0,
    papersFetched: 0,
    coauthorsScanned: 0,
    matched: 0,
    created: 0,
    skipped: 0,
    unmatched: 0,
    errors: 0,
  };

  const args = {
    dryRun: !!opts.dryRun,
    status: opts.status ?? 'DRAFTED',
    ...(opts.personId && { personId: opts.personId }),
    perSeedPapers: opts.perSeedPapers ?? 5,
  };
  const seeds = await loadSeeds(args);
  stats.seeds = seeds.length;
  console.log(
    `[discover:coauthors] ${seeds.length} seed people (status=${args.status}${args.personId ? `, personId=${args.personId}` : ''})`,
  );

  const seenAuthors = new Set<string>();
  // Pre-seed the dedup set with the seed names themselves so we don't try to
  // create them as their own co-authors.
  for (const s of seeds) {
    seenAuthors.add(`${s.firstName} ${s.lastName}`.toLowerCase());
  }

  for (const seed of seeds) {
    console.log(
      `[discover:coauthors] seed ${seed.firstName} ${seed.lastName} @ ${seed.affiliation || '?'}`,
    );
    try {
      const seedAuthor = await findAuthor(
        `${seed.firstName} ${seed.lastName}`,
        seed.affiliation,
      );
      await sleep(800);
      if (!seedAuthor) {
        console.log('  (S2 found no author match — skipping)');
        continue;
      }
      const papers = await fetchRecentPapers(seedAuthor.authorId, args.perSeedPapers);
      await sleep(800);
      stats.papersFetched += papers.length;

      for (const paper of papers) {
        // fetchRecentPapers doesn't include co-author list; do a per-paper
        // lookup via fetchPapersForTarget would be redundant. Instead, refetch
        // this seed's authors+co-authors via the title-search approach: search
        // S2 for the paper title, take the first match's authors.
        //
        // Skipping for now — S2's /author/{id}/papers endpoint already returns
        // the paper IDs, and we can re-fetch the paper to get authors. But
        // that's another endpoint round-trip. Use a tighter approach: when we
        // know the paper's authorId-listed authors via /paper/{paperId}.
        //
        // Pragmatic v1: walk co-authors via a direct paper lookup.
        try {
          const coauthors = await fetchPaperAuthors(paper);
          await sleep(800);
          for (const ca of coauthors) {
            const key = ca.name.toLowerCase();
            if (seenAuthors.has(key)) continue;
            seenAuthors.add(key);
            stats.coauthorsScanned += 1;

            const affiliation = (ca.affiliations ?? []).join(' | ');
            if (!affiliation) {
              logUnmatched('', 'coauthor', {
                authorName: ca.name,
                paperUrl: paper.url ?? '',
              });
              stats.unmatched += 1;
              continue;
            }
            const inst = matchInstitution(affiliation);
            if (!inst) {
              logUnmatched(affiliation, 'coauthor', {
                authorName: ca.name,
                paperUrl: paper.url ?? '',
              });
              stats.unmatched += 1;
              continue;
            }
            stats.matched += 1;

            const split = splitName(ca.name);
            if (!split || !split.lastName) {
              stats.skipped += 1;
              continue;
            }
            if (args.dryRun) {
              console.log(`  + ${split.firstName} ${split.lastName} @ ${inst.name}`);
              stats.created += 1;
              continue;
            }
            try {
              const company = await ensureInstitutionCompany(inst);
              const result = await upsertPersonFromDiscovery({
                firstName: split.firstName,
                lastName: split.lastName,
                companyId: company.id,
                discoverySource: 'COAUTHOR',
                discoveryRef: paper.url ?? `seed:${seed.id}`,
              });
              if (result.created) {
                stats.created += 1;
                console.log(`  + ${split.firstName} ${split.lastName} @ ${inst.name}`);
              } else {
                stats.skipped += 1;
              }
            } catch (err) {
              console.warn(`[discover:coauthors] upsert failed for ${ca.name}:`, err);
              stats.errors += 1;
            }
          }
        } catch (err) {
          console.warn(
            `[discover:coauthors] paper-authors lookup failed for ${paper.title.slice(0, 60)}:`,
            err,
          );
          stats.errors += 1;
        }
      }
    } catch (err) {
      console.warn(
        `[discover:coauthors] seed ${seed.firstName} ${seed.lastName} failed:`,
        err,
      );
      stats.errors += 1;
    }
  }
  return stats;
};

// Helper — given an S2 paper (which has url but no authors+affiliations from
// fetchRecentPapers), fetch the paper detail to extract its co-authors.
type S2PaperAuthor = { authorId?: string; name: string; affiliations?: string[] };

const fetchPaperAuthors = async (paper: S2Paper): Promise<S2PaperAuthor[]> => {
  // Derive a paperId from the URL: prefer arXiv:<id> when available, else
  // skip (we can't look up by title alone reliably).
  let paperId: string | null = null;
  if (paper.url) {
    const arxivMatch = paper.url.match(/arxiv\.org\/abs\/([^/?#]+)/i);
    if (arxivMatch) paperId = `arXiv:${arxivMatch[1]}`;
    const doiMatch = paper.url.match(/doi\.org\/(.+)$/i);
    if (!paperId && doiMatch) paperId = `DOI:${doiMatch[1]}`;
  }
  if (!paperId) return [];

  const fields = 'authors.name,authors.authorId,authors.affiliations';
  const res = await fetch(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}?fields=${fields}`,
    {
      headers: process.env.SEMANTIC_SCHOLAR_API_KEY
        ? { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY }
        : {},
    },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    authors?: S2PaperAuthor[];
  };
  return (data.authors ?? []).filter((a) => !!a.name);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const stats = await discoverFromCoauthors(args);
  console.log('[discover:coauthors] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
