// L1 discovery orchestrator. Runs all sources and reports a summary.
// Per-source failures are isolated; one bad API key won't kill the others.
//
// Sources:
//   arxiv      — daily arXiv feed, allowlist-filtered
//   similar    — Exa findSimilar around SEED_PAPERS
//   apollo     — title search inside ICP_COMPANIES
//   github     — contributor crawl on ROBOTICS_REPOS, cross-referenced to ICPs
//   citations  — S2 citation walk from CITATION_SEEDS
//   coauthors  — expand from existing CRM seeds (DRAFTED status by default)
//
// All sources are idempotent. Skip individual sources with --skip=<name>
// (comma-separated). --dry-run forwards through to each source.
import 'dotenv/config';

import { discoverFromApollo } from './discover-apollo.js';
import { discoverFromArxiv } from './discover-arxiv.js';
import { discoverFromCitations } from './discover-citations.js';
import { discoverFromCoauthors } from './discover-coauthors.js';
import { discoverFromGithub } from './discover-github.js';
import { discoverFromSimilar } from './discover-similar.js';

const settled = async <T>(label: string, p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    console.error(`[discover:all] ${label} failed:`, err);
    return null;
  }
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const skip = new Set(
    process.argv
      .filter((a) => a.startsWith('--skip='))
      .flatMap((a) => a.replace('--skip=', '').split(',')),
  );

  console.log(
    `[discover:all] dryRun=${dryRun} skip=${[...skip].join(',') || 'none'}`,
  );

  const results: Record<string, unknown> = {};

  if (!skip.has('arxiv')) {
    results.arxiv = await settled('arxiv', discoverFromArxiv({ dryRun }));
  }
  if (!skip.has('similar')) {
    results.similar = await settled('similar', discoverFromSimilar({ dryRun }));
  }
  if (!skip.has('apollo')) {
    results.apollo = await settled('apollo', discoverFromApollo({ dryRun }));
  }
  if (!skip.has('github')) {
    results.github = await settled('github', discoverFromGithub({ dryRun }));
  }
  if (!skip.has('citations')) {
    results.citations = await settled('citations', discoverFromCitations({ dryRun }));
  }
  if (!skip.has('coauthors')) {
    results.coauthors = await settled('coauthors', discoverFromCoauthors({ dryRun }));
  }

  console.log('[discover:all] summary:');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(10)}:`, v ?? 'SKIPPED/FAILED');
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
