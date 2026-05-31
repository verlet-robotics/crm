// L1 discovery — Exa findSimilar.
//
// Seeds: SEED_PAPERS curated list of exemplar papers. For each seed, ask Exa
// for similar papers, then extract author names from result text. Try to map
// each author → known institution → CRM upsert.
//
// Lower precision than arXiv (Exa's text excerpts vary), but excellent recall
// for adjacent researchers.
import 'dotenv/config';

import { findSimilarPapers } from '../research/scrapers/exa.js';
import { findAuthor } from '../research/scrapers/papers.js';
import { upsertPersonFromDiscovery } from '../lib/twenty-client.js';

import {
  ensureInstitutionCompany,
  logUnmatched,
  matchInstitution,
} from './match-institution.js';
import { SEED_PAPERS } from './sources.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Common capitalized bigrams in ML papers that LOOK like names but aren't.
// Anything here is dropped before S2 lookup — they tend to match the wrong
// real-person author by name similarity, which would silently corrupt CRM.
const TECH_BIGRAM_STOPWORDS = new Set(
  [
    'Diffusion Policy',
    'Robot Learning',
    'Imitation Learning',
    'Behavior Cloning',
    'Reinforcement Learning',
    'Vision Language',
    'Language Action',
    'Action Model',
    'Visual Servoing',
    'Visual Manipulation',
    'Dexterous Manipulation',
    'Tactile Sensing',
    'Foundation Model',
    'Foundation Models',
    'Sim Real',
    'Sim To',
    'Real World',
    'Neural Network',
    'Deep Learning',
    'Self Supervised',
    'Open Source',
    'Manipulation Tasks',
    'Robot Manipulation',
    'Object Manipulation',
    'Point Cloud',
    'Latent Space',
    'World Model',
    'Generative Model',
    'Token Generation',
    'Embodied Agent',
    'Embodied Agents',
    'Embodied AI',
    'Open AI',
    'Google Research',
    'NVIDIA Research',
    'Toyota Research',
    'Physical Intelligence',
    'Stanford University',
    'Berkeley University',
    'University Of',
    'In This',
    'This Paper',
    'This Work',
    'Our Approach',
    'Our Method',
    'Our Model',
    'Our Results',
    'We Propose',
    'We Present',
    'We Introduce',
  ].map((s) => s.toLowerCase()),
);

// Common given names — bigrams whose first token is one of these get a
// confidence bump. Otherwise we require S2 to return an author whose own
// name shares a token with the extracted bigram before accepting them.
const COMMON_GIVEN_NAMES = new Set(
  [
    'Alex', 'Andrew', 'Anna', 'Anthony', 'Ben', 'Bryan', 'Charles', 'Chen',
    'Chris', 'Daniel', 'David', 'Eric', 'Felix', 'Hao', 'Henry', 'Jack',
    'James', 'Jane', 'Jason', 'Jeff', 'Jia', 'Jiaming', 'John', 'Jonathan',
    'Justin', 'Kevin', 'Lerrel', 'Li', 'Linda', 'Mark', 'Matt', 'Matthew',
    'Michael', 'Mike', 'Pieter', 'Russ', 'Sergey', 'Sherry', 'Shuran', 'Song',
    'Stefan', 'Tony', 'William', 'Xiaolong', 'Xinyang', 'Yi', 'Yifeng',
    'Yilun', 'Yuke', 'Zhe', 'Zhenjia',
  ].map((s) => s.toLowerCase()),
);

// Heuristic: arXiv abstracts tend to start with author bylines like
// "Jane Doe, John Roe — Stanford University —"; we extract capitalized
// two-word names and ignore the rest. Imperfect; tightened by stopword filter
// + post-validation against S2's returned name.
const AUTHOR_NAME_REGEX = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,20})\b/g;

const extractCandidateNames = (text: string): string[] => {
  const seen = new Set<string>();
  const matches = text.matchAll(AUTHOR_NAME_REGEX);
  for (const m of matches) {
    const candidate = `${m[1]} ${m[2]}`;
    if (TECH_BIGRAM_STOPWORDS.has(candidate.toLowerCase())) continue;
    seen.add(candidate);
    if (seen.size >= 12) break; // cap per paper
  }
  return [...seen];
};

const splitName = (full: string): { firstName: string; lastName: string } => {
  const parts = full.split(' ');
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
};

// Verify that S2's returned author actually shares tokens with the bigram
// we extracted. Without this, S2's fuzzy search can return arbitrary
// near-matches (e.g. "Robot Learning" → some real "Robert Lear" author).
const authorMatchesBigram = (
  bigram: string,
  s2AuthorName: string | undefined,
): boolean => {
  if (!s2AuthorName) return false;
  const bigramTokens = bigram.toLowerCase().split(/\s+/).filter(Boolean);
  const authorTokens = s2AuthorName.toLowerCase().split(/\s+/).filter(Boolean);
  // Require at least the surname (second bigram token) to appear in the
  // author's name. The given-name token may be initialed in S2.
  const surname = bigramTokens[bigramTokens.length - 1];
  if (!surname || surname.length < 3) return false;
  return authorTokens.some((t) => t === surname || t.startsWith(surname));
};

type Stats = { created: number; skipped: number; unmatched: number; errors: number };

export const discoverFromSimilar = async (
  opts: { dryRun?: boolean } = {},
): Promise<Stats> => {
  const stats: Stats = { created: 0, skipped: 0, unmatched: 0, errors: 0 };
  const seenAuthors = new Set<string>();

  for (const seed of SEED_PAPERS) {
    console.log(`[discover:similar] findSimilar(${seed})`);
    let similar: Awaited<ReturnType<typeof findSimilarPapers>>;
    try {
      similar = await findSimilarPapers(seed, 8);
    } catch (err) {
      console.warn(`[discover:similar] findSimilar failed for ${seed}:`, err);
      stats.errors += 1;
      continue;
    }

    for (const paper of similar) {
      const candidates = extractCandidateNames(paper.text ?? paper.title ?? '');
      for (const name of candidates) {
        const key = name.toLowerCase();
        if (seenAuthors.has(key)) continue;
        seenAuthors.add(key);

        try {
          const author = await findAuthor(name, '');
          await sleep(800);
          if (!author) {
            stats.unmatched += 1;
            continue;
          }
          // Guard against S2 fuzzy-matching the wrong real author. Require
          // the bigram's surname to actually appear in the returned name —
          // unless the bigram's given-name is a clearly-personal token,
          // in which case we trust S2's match.
          const givenIsPersonal = COMMON_GIVEN_NAMES.has(
            name.split(' ')[0].toLowerCase(),
          );
          if (!givenIsPersonal && !authorMatchesBigram(name, author.name)) {
            stats.unmatched += 1;
            continue;
          }
          const affiliation = (author.affiliations ?? []).join(' | ');
          const inst = matchInstitution(affiliation);
          if (!inst) {
            logUnmatched(affiliation, 'similar', {
              authorName: name,
              paperUrl: paper.url,
            });
            stats.unmatched += 1;
            continue;
          }

          const { firstName, lastName } = splitName(name);
          if (opts.dryRun) {
            console.log(`  + ${firstName} ${lastName} @ ${inst.name}`);
            stats.created += 1;
            continue;
          }

          const company = await ensureInstitutionCompany(inst);
          const result = await upsertPersonFromDiscovery({
            firstName,
            lastName,
            companyId: company.id,
            discoverySource: 'EXA_SIMILAR',
            discoveryRef: paper.url,
          });
          if (result.created) {
            stats.created += 1;
            console.log(`  + ${firstName} ${lastName} @ ${inst.name}`);
          } else {
            stats.skipped += 1;
          }
        } catch (err) {
          console.warn(`[discover:similar] ${name} failed:`, err);
          stats.errors += 1;
        }
      }
    }
  }
  return stats;
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await discoverFromSimilar({ dryRun });
  console.log('[discover:similar] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
