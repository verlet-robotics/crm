// Stage 1 orchestrator — institution discovery.
//
// Runs the three scanners (arxiv affiliations, GitHub orgs, funding news),
// folds in the historical .state/unmatched.jsonl tally, scores candidates,
// and upserts the top-N as draft Twenty Companies with pendingReview=true.
// Closes the loop by creating one Twenty Task summarizing the count.
//
// CLI:
//   yarn stage1:scan                        # run all scanners + upsert
//   yarn stage1:scan --dry-run              # print only; no CRM writes
//   yarn stage1:scan --no-arxiv             # skip arxiv-affiliations scan
//   yarn stage1:scan --no-github            # skip github org scan
//   yarn stage1:scan --no-funding           # skip funding news scan
//   yarn stage1:scan --use-cache            # read .state/*.json instead of re-running
//   yarn stage1:scan --top 30 --min-score 5 # tune thresholds
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  createTaskForUser,
  upsertCandidateCompany,
  type CompanyDiscoverySource,
} from '../lib/twenty-client.js';

import { UNMATCHED_LOG_PATH } from './match-institution.js';
import { scanArxivAffiliations, type ArxivAffiliationHit } from './scan-arxiv-affiliations.js';
import { scanFundingNews, type FundingNewsHit } from './scan-funding-news.js';
import { scanGithubOrgs, type GithubOrgHit } from './scan-github-orgs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../../.state');

const ARXIV_CACHE = path.join(STATE_DIR, 'scan-arxiv-affiliations.json');
const GITHUB_CACHE = path.join(STATE_DIR, 'scan-github-orgs.json');
const FUNDING_CACHE = path.join(STATE_DIR, 'scan-funding-news.json');

type Candidate = {
  name: string;
  domain?: string;
  discoverySource: CompanyDiscoverySource;
  discoveryRef: string;
  signalSummary: string;
  score: number;
};

const settled = async <T>(label: string, p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    console.warn(`[stage1:scan] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
};

// ─── Source readers ───────────────────────────────────────────────────

const readJson = <T>(p: string): T | null => {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
};

const parseBlogDomain = (blog: string | undefined): string | undefined => {
  if (!blog) return undefined;
  const trimmed = blog
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
    .trim();
  if (!trimmed.includes('.')) return undefined;
  return trimmed;
};

// ─── Mapping each scanner → Candidates ────────────────────────────────

const fromArxiv = (hits: ArxivAffiliationHit[]): Candidate[] =>
  hits
    .filter((h) => h.paperCount >= 2) // single papers are noise
    .map((h) => ({
      // arXiv affiliation strings can be 'University of X, Department of Y' —
      // keep the raw string but truncate so it's not 200 chars in the CRM.
      name: h.affiliation.slice(0, 80),
      discoverySource: 'ARXIV' as CompanyDiscoverySource,
      discoveryRef: h.samplePapers[0] ?? '',
      signalSummary: `${h.paperCount} arXiv papers in last 30d (sample: ${h.samplePapers[0] ?? ''})`,
      score: h.paperCount * 3,
    }));

const fromGithub = (hits: GithubOrgHit[]): Candidate[] =>
  hits
    .filter((h) => h.totalStars >= 100 || h.repoCount >= 2)
    .map((h) => {
      const domain = parseBlogDomain(h.blog);
      return {
        name: h.name ?? h.login,
        ...(domain && { domain }),
        discoverySource: 'GITHUB' as CompanyDiscoverySource,
        discoveryRef: `https://github.com/${h.login}`,
        signalSummary: `GitHub org "${h.login}": ${h.repoCount} robotics repos, ${h.totalStars}★ total${h.location ? `, ${h.location}` : ''}${h.description ? ` — ${h.description.slice(0, 80)}` : ''}`,
        score: Math.min(50, Math.floor(h.totalStars / 100) + h.repoCount * 2),
      };
    });

const fromFunding = (hits: FundingNewsHit[]): Candidate[] =>
  hits.map((h) => ({
    name: h.name,
    discoverySource: 'FUNDING_NEWS' as CompanyDiscoverySource,
    discoveryRef: h.url ?? '',
    signalSummary: `Recent funding${h.round ? ` (${h.round}` : ''}${h.amount ? ` ${h.amount}` : ''}${h.round ? ')' : ''}${h.thesis ? ` — ${h.thesis}` : ''}`,
    score: 50, // funding signal is high-precision; flat boost
  }));

// ─── unmatched.jsonl aggregation ──────────────────────────────────────

const STOPWORDS = [
  'department of',
  'department',
  'school of',
  'school',
  'institute of',
  'laboratory',
  'lab',
  'group',
  'center for',
  'centre for',
  'center',
  'centre',
  'faculty of',
];

const normalizeAffiliation = (raw: string): string => {
  let s = raw.toLowerCase().trim();
  for (const sw of STOPWORDS) s = s.replaceAll(sw, ' ');
  s = s.replace(/[,;|·]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
};

type UnmatchedRow = {
  affiliation: string;
  source: string;
  authorName?: string;
  paperUrl?: string;
};

const readUnmatched = async (): Promise<Map<string, { raw: string; count: number; samplePaper?: string }>> => {
  const out = new Map<string, { raw: string; count: number; samplePaper?: string }>();
  if (!fs.existsSync(UNMATCHED_LOG_PATH)) return out;
  const stream = fs.createReadStream(UNMATCHED_LOG_PATH);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: UnmatchedRow;
    try {
      row = JSON.parse(line) as UnmatchedRow;
    } catch {
      continue;
    }
    if (!row.affiliation || row.affiliation.length < 3) continue;
    const key = normalizeAffiliation(row.affiliation);
    if (!key) continue;
    const existing = out.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      out.set(key, {
        raw: row.affiliation,
        count: 1,
        ...(row.paperUrl && { samplePaper: row.paperUrl }),
      });
    }
  }
  return out;
};

const fromUnmatched = async (): Promise<Candidate[]> => {
  const map = await readUnmatched();
  const list: Candidate[] = [];
  for (const v of map.values()) {
    if (v.count < 3) continue; // historical noise floor
    list.push({
      name: v.raw.slice(0, 80),
      discoverySource: 'INSTITUTION_SCAN' as CompanyDiscoverySource,
      discoveryRef: v.samplePaper ?? '',
      signalSummary: `${v.count}× seen in unmatched affiliations log${v.samplePaper ? ` (sample: ${v.samplePaper})` : ''}`,
      score: Math.min(40, v.count * 2),
    });
  }
  return list;
};

// ─── Merge + score ────────────────────────────────────────────────────

const mergeKey = (c: Candidate): string =>
  c.domain ?? c.name.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);

const mergeCandidates = (lists: Candidate[][]): Candidate[] => {
  const merged = new Map<string, Candidate>();
  for (const list of lists) {
    for (const c of list) {
      const key = mergeKey(c);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...c });
      } else {
        existing.score += c.score;
        existing.signalSummary += ` | ${c.signalSummary}`;
        if (!existing.domain && c.domain) existing.domain = c.domain;
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
};

// ─── Orchestrator ─────────────────────────────────────────────────────

type Args = {
  dryRun: boolean;
  useCache: boolean;
  skipArxiv: boolean;
  skipGithub: boolean;
  skipFunding: boolean;
  top: number;
  minScore: number;
  lookbackDays: number;
};

const parseArgs = (argv: string[]): Args => {
  const num = (flag: string, dflt: number): number => {
    const f = argv.find((a) => a.startsWith(`${flag}=`));
    if (!f) return dflt;
    const n = Number(f.replace(`${flag}=`, ''));
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    useCache: argv.includes('--use-cache'),
    skipArxiv: argv.includes('--no-arxiv'),
    skipGithub: argv.includes('--no-github'),
    skipFunding: argv.includes('--no-funding'),
    top: num('--top', 25),
    minScore: num('--min-score', 6),
    lookbackDays: num('--lookback', 30),
  };
};

export const aggregateInstitutions = async (args: Args): Promise<{ candidates: Candidate[]; upserted: number }> => {
  console.log(
    `[stage1:scan] dryRun=${args.dryRun} useCache=${args.useCache} top=${args.top} minScore=${args.minScore}`,
  );

  // Source 1: arXiv affiliations
  let arxivHits: ArxivAffiliationHit[] | null = null;
  if (!args.skipArxiv) {
    if (args.useCache) {
      arxivHits = readJson<ArxivAffiliationHit[]>(ARXIV_CACHE);
    } else {
      arxivHits = await settled(
        'arxiv-affiliations',
        scanArxivAffiliations({ lookbackDays: args.lookbackDays }),
      );
      if (arxivHits) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(ARXIV_CACHE, JSON.stringify(arxivHits, null, 2), 'utf-8');
      }
    }
  }

  // Source 2: GitHub orgs
  let githubHits: GithubOrgHit[] | null = null;
  if (!args.skipGithub) {
    if (args.useCache) {
      githubHits = readJson<GithubOrgHit[]>(GITHUB_CACHE);
    } else {
      githubHits = await settled('github-orgs', scanGithubOrgs({}));
      if (githubHits) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(GITHUB_CACHE, JSON.stringify(githubHits, null, 2), 'utf-8');
      }
    }
  }

  // Source 3: funding news
  let fundingHits: FundingNewsHit[] | null = null;
  if (!args.skipFunding) {
    if (args.useCache) {
      fundingHits = readJson<FundingNewsHit[]>(FUNDING_CACHE);
    } else {
      fundingHits = await settled('funding-news', scanFundingNews({ lookbackDays: 60 }));
      if (fundingHits) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(FUNDING_CACHE, JSON.stringify(fundingHits, null, 2), 'utf-8');
      }
    }
  }

  // Source 4: unmatched.jsonl aggregate
  const unmatched = await fromUnmatched();

  const merged = mergeCandidates([
    arxivHits ? fromArxiv(arxivHits) : [],
    githubHits ? fromGithub(githubHits) : [],
    fundingHits ? fromFunding(fundingHits) : [],
    unmatched,
  ]).filter((c) => c.score >= args.minScore);

  const top = merged.slice(0, args.top);

  // Print table.
  console.log('');
  console.log('─'.repeat(100));
  console.log(`score  source            name${' '.repeat(36)}domain               signal`);
  console.log('─'.repeat(100));
  for (const c of top) {
    const name = c.name.padEnd(40).slice(0, 40);
    const domain = (c.domain ?? '—').padEnd(20).slice(0, 20);
    const signal = c.signalSummary.slice(0, 80);
    console.log(
      `${String(c.score).padStart(4)}   ${c.discoverySource.padEnd(16)}  ${name}  ${domain}  ${signal}`,
    );
  }
  console.log('─'.repeat(100));
  console.log(
    `[stage1:scan] merged=${merged.length} (filtered by minScore=${args.minScore}); top=${top.length}`,
  );

  if (args.dryRun || top.length === 0) {
    console.log('[stage1:scan] DRY RUN or no candidates — no CRM writes');
    return { candidates: top, upserted: 0 };
  }

  // Upsert as draft Companies.
  let upserted = 0;
  for (const c of top) {
    try {
      const result = await upsertCandidateCompany({
        name: c.name,
        ...(c.domain && { domainName: c.domain }),
        discoverySource: c.discoverySource,
        discoveryRef: c.discoveryRef,
        signalSummary: c.signalSummary,
      });
      if (result.created) {
        upserted += 1;
        console.log(`  + ${c.name} (${c.discoverySource})`);
      }
    } catch (err) {
      console.warn(
        `[stage1:scan] upsert failed for ${c.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Create one Twenty Task summarizing the run.
  try {
    const summaryLines = top
      .slice(0, 15)
      .map((c) => `- **${c.name}** (${c.discoverySource}, score=${c.score}): ${c.signalSummary.slice(0, 120)}`);
    await createTaskForUser({
      title: `Stage 1: ${upserted} new candidate institutions to review`,
      bodyMarkdown: [
        `Stage 1 institution-discovery scan finished. ${upserted} new Companies were upserted with \`pendingReview=true\`.`,
        '',
        `**Filter in Twenty:** Companies where \`pendingReview\` is true.`,
        '',
        `**For each:** set \`accountType\` to \`COMPANY\` / \`INSTITUTION\` / \`LAB\` (or delete), then clear \`pendingReview\`.`,
        '',
        `Top ${Math.min(15, top.length)} candidates this run:`,
        '',
        ...summaryLines,
      ].join('\n'),
    });
  } catch (err) {
    console.warn(
      `[stage1:scan] task creation failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  console.log(`[stage1:scan] done — ${upserted} new draft Companies + 1 task`);
  return { candidates: top, upserted };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await aggregateInstitutions(args);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
