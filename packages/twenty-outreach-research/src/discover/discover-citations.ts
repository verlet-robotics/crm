// L1 discovery — citation walker.
//
// Complementary to Exa findSimilar:
//   - findSimilar = semantic neighborhood (papers about similar topics)
//   - citations  = structural neighborhood (papers actively building on top
//                  of the seed)
//
// Flow per seed paper (CITATION_SEEDS):
//   1. S2 /paper/{arxivId}/citations → up to 100 papers citing the seed.
//   2. For each citing paper, walk authors.
//   3. For authors with affiliations directly attached, run matchInstitution.
//   4. For authors without affiliations, fall back to findAuthor name lookup
//      (rate-limited at 800ms).
//   5. On match, upsert Person at the institution with discoverySource=
//      CITATIONS and discoveryRef pointing to the citing paper URL.
//
// The structural signal is high-precision: anyone citing Pi0 / Diffusion
// Policy / ALOHA / RT-X / Octo in a 2025-2026 paper IS in our buyer set.
import 'dotenv/config';

import {
  fetchCitations,
  findAuthor,
  type S2CitingPaper,
} from '../research/scrapers/papers.js';
import { upsertPersonFromDiscovery } from '../lib/twenty-client.js';

import {
  ensureInstitutionCompany,
  logUnmatched,
  matchInstitution,
} from './match-institution.js';
import { CITATION_SEEDS } from './sources.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const splitName = (full: string): { firstName: string; lastName: string } | null => {
  const cleaned = full.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
};

type Stats = {
  papers: number;
  authors: number;
  withAffiliation: number;
  fallbackLookups: number;
  matched: number;
  created: number;
  skipped: number;
  unmatched: number;
  errors: number;
};

const citingPaperUrl = (p: S2CitingPaper): string =>
  p.arxivId ? `https://arxiv.org/abs/${p.arxivId}` : (p.url ?? `s2:${p.paperId}`);

export const discoverFromCitations = async (
  opts: { dryRun?: boolean; perSeedLimit?: number } = {},
): Promise<Stats> => {
  const stats: Stats = {
    papers: 0,
    authors: 0,
    withAffiliation: 0,
    fallbackLookups: 0,
    matched: 0,
    created: 0,
    skipped: 0,
    unmatched: 0,
    errors: 0,
  };
  const seenAuthors = new Set<string>();
  const perSeedLimit = opts.perSeedLimit ?? 100;

  for (const seed of CITATION_SEEDS) {
    console.log(`[discover:citations] ${seed.title} (${seed.arxivId})`);
    let citing: S2CitingPaper[];
    try {
      citing = await fetchCitations(seed.arxivId, perSeedLimit);
    } catch (err) {
      console.warn(`[discover:citations] fetchCitations failed for ${seed.arxivId}:`, err);
      stats.errors += 1;
      continue;
    }
    console.log(`  → ${citing.length} citing papers`);
    stats.papers += citing.length;

    for (const paper of citing) {
      const paperUrl = citingPaperUrl(paper);
      for (const author of paper.authors) {
        const key = author.name.toLowerCase();
        if (seenAuthors.has(key)) continue;
        seenAuthors.add(key);
        stats.authors += 1;

        try {
          let affiliation = (author.affiliations ?? []).join(' | ');
          if (affiliation) {
            stats.withAffiliation += 1;
          } else {
            // S2's citations endpoint returns empty affiliations more often
            // than the author endpoint. Fall back to a directed lookup —
            // costs a request but the precision is worth it.
            stats.fallbackLookups += 1;
            const resolved = await findAuthor(author.name, '');
            await sleep(800);
            affiliation = (resolved?.affiliations ?? []).join(' | ');
          }

          if (!affiliation) {
            logUnmatched('', 'citations', {
              authorName: author.name,
              paperUrl,
            });
            stats.unmatched += 1;
            continue;
          }

          const inst = matchInstitution(affiliation);
          if (!inst) {
            logUnmatched(affiliation, 'citations', {
              authorName: author.name,
              paperUrl,
            });
            stats.unmatched += 1;
            continue;
          }
          stats.matched += 1;

          const split = splitName(author.name);
          if (!split || !split.lastName) {
            stats.skipped += 1;
            continue;
          }
          if (opts.dryRun) {
            console.log(`  + ${split.firstName} ${split.lastName} @ ${inst.name}`);
            stats.created += 1;
            continue;
          }

          const company = await ensureInstitutionCompany(inst);
          const result = await upsertPersonFromDiscovery({
            firstName: split.firstName,
            lastName: split.lastName,
            companyId: company.id,
            discoverySource: 'CITATIONS',
            discoveryRef: paperUrl,
          });
          if (result.created) {
            stats.created += 1;
            console.log(`  + ${split.firstName} ${split.lastName} @ ${inst.name}`);
          } else {
            stats.skipped += 1;
          }
        } catch (err) {
          console.warn(`[discover:citations] ${author.name} failed:`, err);
          stats.errors += 1;
        }
      }
    }
  }
  return stats;
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await discoverFromCitations({ dryRun });
  console.log('[discover:citations] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
