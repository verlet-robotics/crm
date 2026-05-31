// Stage 1 scanner — arXiv affiliations.
//
// Pull recent papers in cs.RO/cs.AI/cs.LG matching the same keyword filter
// the per-arxiv discovery uses. For each paper, fetch authors + affiliations
// from Semantic Scholar (S2 has them; arXiv usually doesn't). For each
// affiliation NOT matched by INSTITUTION_ALLOWLIST, record a hit.
//
// Aggregation lives in institutions-aggregate.ts — this scanner writes the
// raw scan output to JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchArxiv } from './arxiv.js';
import { matchInstitution } from './match-institution.js';
import { ARXIV_FEED } from './sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../../.state');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type S2PaperDetail = {
  authors?: { name: string; affiliations?: string[] }[];
};

const fetchS2Affiliations = async (arxivId: string): Promise<string[]> => {
  // S2 accepts arXiv:<id> as a paper identifier. Strip the URL.
  const cleanId = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '');
  const url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURIComponent(
    cleanId,
  )}?fields=authors.affiliations`;
  const res = await fetch(url, {
    headers: process.env.SEMANTIC_SCHOLAR_API_KEY
      ? { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY }
      : {},
  });
  if (!res.ok) return [];
  const data = (await res.json()) as S2PaperDetail;
  const all: string[] = [];
  for (const a of data.authors ?? []) {
    for (const aff of a.affiliations ?? []) {
      if (aff) all.push(aff);
    }
  }
  return all;
};

export type ArxivAffiliationHit = {
  affiliation: string;
  paperCount: number;
  samplePapers: string[];
  // First seen at this run only — historical aggregation is institutions-aggregate.ts's job.
};

export const scanArxivAffiliations = async (
  opts: { lookbackDays?: number; maxPapers?: number } = {},
): Promise<ArxivAffiliationHit[]> => {
  const lookback = opts.lookbackDays ?? 30;
  const max = opts.maxPapers ?? 200;
  console.log(`[stage1:scan-arxiv] lookback=${lookback}d max=${max}`);

  const papers = await searchArxiv({
    categories: ARXIV_FEED.categories,
    keywords: ARXIV_FEED.keywords,
    startDays: lookback,
    maxResults: max,
  });
  console.log(`[stage1:scan-arxiv] ${papers.length} papers in window`);

  // affiliation (normalized) → { raw samples, paper URLs }
  const buckets = new Map<string, { raw: string; papers: Set<string> }>();

  let processed = 0;
  for (const p of papers) {
    processed += 1;
    try {
      const affiliations = await fetchS2Affiliations(p.id);
      for (const aff of affiliations) {
        if (matchInstitution(aff)) continue; // already in allowlist
        const key = aff.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!key) continue;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { raw: aff, papers: new Set() };
          buckets.set(key, bucket);
        }
        bucket.papers.add(p.url);
      }
    } catch (err) {
      // Single-paper failures are normal (S2 doesn't have every arXiv yet).
      // Don't spam.
    }
    if (processed % 20 === 0) {
      console.log(
        `[stage1:scan-arxiv] processed ${processed}/${papers.length}, ${buckets.size} unknown affiliations so far`,
      );
    }
    // Pace to stay under S2's unauthenticated rate limit (~1 req/sec).
    await sleep(process.env.SEMANTIC_SCHOLAR_API_KEY ? 200 : 1100);
  }

  const hits: ArxivAffiliationHit[] = [...buckets.values()]
    .map((b) => ({
      affiliation: b.raw,
      paperCount: b.papers.size,
      samplePapers: [...b.papers].slice(0, 3),
    }))
    .sort((a, b) => b.paperCount - a.paperCount);

  console.log(`[stage1:scan-arxiv] done — ${hits.length} unique unknown affiliations`);
  return hits;
};

const main = async () => {
  const args = process.argv.slice(2);
  const lookback = Number(
    args.find((a) => a.startsWith('--lookback='))?.replace('--lookback=', '') ?? '30',
  );
  const max = Number(
    args.find((a) => a.startsWith('--max='))?.replace('--max=', '') ?? '150',
  );
  const hits = await scanArxivAffiliations({ lookbackDays: lookback, maxPapers: max });

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = path.join(STATE_DIR, 'scan-arxiv-affiliations.json');
  fs.writeFileSync(out, JSON.stringify(hits, null, 2), 'utf-8');
  console.log(`[stage1:scan-arxiv] wrote ${hits.length} hits → ${out}`);

  console.log('\nTop 10:');
  for (const h of hits.slice(0, 10)) {
    console.log(`  ${String(h.paperCount).padStart(3)}× ${h.affiliation}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
