// L1 discovery — arXiv daily.
//
// Loop:
//   1. Pull recent papers from arXiv (cs.RO|LG|CV|AI + keyword filter, last 2d).
//   2. For each paper, walk authors → look up affiliations via Semantic Scholar.
//      (arXiv's API omits affiliations for ~99% of submissions.)
//   3. If any author's affiliation matches INSTITUTION_ALLOWLIST, upsert the
//      Company and create a Person with researchStatus=NEEDS_RESEARCH and a
//      discoveryRef pointing back to the arXiv URL.
//
// Idempotent — existing People (matched by name) are skipped. No emails are
// guessed; the L2 research step will surface them later.
import 'dotenv/config';

import { findAuthor } from '../research/scrapers/papers.js';
import { upsertPersonFromDiscovery } from '../lib/twenty-client.js';

import { type ArxivPaper, searchArxiv } from './arxiv.js';
import {
  ensureInstitutionCompany,
  logUnmatched,
  matchInstitution,
} from './match-institution.js';
import { ARXIV_FEED } from './sources.js';

const splitName = (full: string): { firstName: string; lastName: string } => {
  const parts = full.replace(/\s+/g, ' ').trim().split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
};

// Rate-limit Semantic Scholar lookups; without an API key we get ~1 req/sec.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Discovered = {
  created: number;
  skipped: number;
  unmatched: number;
  errors: number;
};

export const discoverFromArxiv = async (
  opts: { dryRun?: boolean; maxPapers?: number } = {},
): Promise<Discovered> => {
  console.log('[discover:arxiv] querying arXiv…');
  const papers = await searchArxiv({
    categories: ARXIV_FEED.categories,
    keywords: ARXIV_FEED.keywords,
    startDays: ARXIV_FEED.lookbackDays,
    maxResults: opts.maxPapers ?? 200,
  });
  console.log(`[discover:arxiv] ${papers.length} recent papers match filters`);

  const stats: Discovered = { created: 0, skipped: 0, unmatched: 0, errors: 0 };
  const seenAuthors = new Set<string>();

  for (const paper of papers) {
    for (const author of paper.authors) {
      const key = author.name.toLowerCase();
      if (seenAuthors.has(key)) continue;
      seenAuthors.add(key);

      try {
        const affiliation = await resolveAffiliation(author.name, author.affiliation);
        if (!affiliation) {
          logUnmatched('', 'arxiv', { authorName: author.name, paperUrl: paper.url });
          stats.unmatched += 1;
          continue;
        }
        const inst = matchInstitution(affiliation);
        if (!inst) {
          logUnmatched(affiliation, 'arxiv', {
            authorName: author.name,
            paperUrl: paper.url,
          });
          stats.unmatched += 1;
          continue;
        }
        await ingestAuthor(paper, author.name, inst, stats, opts.dryRun);
      } catch (err) {
        console.warn(`[discover:arxiv] author lookup failed: ${author.name}:`, err);
        stats.errors += 1;
      }

      // S2 free tier is ~100 req/5min — pace ourselves.
      await sleep(800);
    }
  }
  return stats;
};

const resolveAffiliation = async (
  name: string,
  arxivAffiliation: string | undefined,
): Promise<string | null> => {
  if (arxivAffiliation) return arxivAffiliation;
  // S2 free tier rarely returns a hit without a hint; pass an empty
  // affiliation and trust the name match. We score downstream against
  // matchers in INSTITUTION_ALLOWLIST.
  const author = await findAuthor(name, '');
  if (!author) return null;
  return (author.affiliations ?? []).join(' | ') || null;
};

const ingestAuthor = async (
  paper: ArxivPaper,
  authorName: string,
  inst: ReturnType<typeof matchInstitution> & object,
  stats: Discovered,
  dryRun?: boolean,
): Promise<void> => {
  const { firstName, lastName } = splitName(authorName);
  if (!firstName || !lastName) {
    stats.skipped += 1;
    return;
  }

  if (dryRun) {
    console.log(
      `[discover:arxiv]  + ${firstName} ${lastName} @ ${inst.name} (paper: ${paper.title.slice(0, 60)}…)`,
    );
    stats.created += 1;
    return;
  }

  const company = await ensureInstitutionCompany(inst);
  const result = await upsertPersonFromDiscovery({
    firstName,
    lastName,
    companyId: company.id,
    discoverySource: 'ARXIV',
    discoveryRef: paper.url,
  });

  if (result.created) {
    stats.created += 1;
    console.log(`  + ${firstName} ${lastName} @ ${inst.name}`);
  } else {
    stats.skipped += 1;
  }
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await discoverFromArxiv({ dryRun });
  console.log('[discover:arxiv] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
