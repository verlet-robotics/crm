// Stage 1 scanner — GitHub organizations.
//
// Search GitHub for recently-active robotics repositories and aggregate by
// owner organization. Filters out owners already represented by the known
// set (ICP_COMPANIES + INSTITUTION_ALLOWLIST + ROBOTICS_REPOS).
//
// Output: top-N candidate orgs with repo counts + sample repo URLs +
// owner-side metadata (org name, description, website, location).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchUser } from './github.js';
import { ICP_COMPANIES, INSTITUTION_ALLOWLIST, ROBOTICS_REPOS } from './sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../../.state');

const GITHUB_BASE = 'https://api.github.com';

const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'verlet-outreach-research/0.1',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
};

type SearchRepoItem = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
  owner: { login: string; type: 'Organization' | 'User' };
  topics?: string[];
};

const searchRepos = async (
  query: string,
  perPage = 50,
  page = 1,
): Promise<SearchRepoItem[]> => {
  const url = `${GITHUB_BASE}/search/repositories?q=${encodeURIComponent(
    query,
  )}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 403 && !process.env.GITHUB_TOKEN) {
      throw new Error(
        'GitHub rate-limited (60/h unauth) — set GITHUB_TOKEN in Doppler to lift to 5000/h',
      );
    }
    throw new Error(`GitHub search → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { items?: SearchRepoItem[] };
  return body.items ?? [];
};

const KNOWN_OWNERS = new Set<string>([
  // From ROBOTICS_REPOS — direct
  ...ROBOTICS_REPOS.map((r) => r.owner.toLowerCase()),
  // Common heuristic owners that map to allowlist entries
  'huggingface',
  'physical-intelligence',
  'octo-models',
  'real-stanford',
  'nvlabs',
  'tonyzhaozh',
  'stanford-iliad',
  'isaac-sim',
]);

const knownByOrgName = (login: string, name: string | null): boolean => {
  const l = login.toLowerCase();
  if (KNOWN_OWNERS.has(l)) return true;
  const haystack = `${l} ${(name ?? '').toLowerCase()}`;
  // Check ICP name (first significant token, ignoring tiny words).
  for (const icp of ICP_COMPANIES) {
    const tokens = icp.name.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
    for (const t of tokens) {
      if (haystack.includes(t)) return true;
    }
  }
  // Check INSTITUTION matchers + display-name tokens (matchers are like "tu munich",
  // but the GitHub display name might just be "TU Munich" — both should match).
  for (const inst of INSTITUTION_ALLOWLIST) {
    const nameTokens = inst.name.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
    for (const t of nameTokens) {
      if (haystack.includes(t)) return true;
    }
    for (const m of inst.matchers) {
      if (haystack.includes(m.toLowerCase())) return true;
    }
  }
  return false;
};

// Reject orgs whose star count is mostly from non-robotics work. Heuristic:
// if average stars-per-robotics-repo exceeds 50K, this is a generic mega-org
// (public-apis, rust-unofficial, etc.) — not a robotics shop.
const isLikelyMegaOrgNoise = (totalStars: number, repoCount: number): boolean => {
  if (repoCount === 0) return true;
  const avg = totalStars / repoCount;
  return avg > 50_000;
};

// Positive relevance filter — the org's display name + bio must mention at
// least one robotics keyword. Drops generic ML communities (dmlc, Datawhale),
// AV sims (CARLA), AI safety (CHAI), and assorted unrelated infra.
const ROBOTICS_KEYWORDS = [
  'robot',
  'robo',
  'manipulation',
  'manipulator',
  'imitation',
  'embodied',
  'dexterous',
  'humanoid',
  'teleop',
  'gripper',
  'grasp',
  'locomotion',
  'physical ai',
  'physical intelligence',
];

const looksRoboticsRelevant = (name: string | undefined, bio: string | undefined): boolean => {
  const haystack = `${name ?? ''} ${bio ?? ''}`.toLowerCase();
  return ROBOTICS_KEYWORDS.some((k) => haystack.includes(k));
};

export type GithubOrgHit = {
  login: string;
  name?: string;
  blog?: string;
  location?: string;
  description?: string;
  repoCount: number;
  totalStars: number;
  sampleRepos: { fullName: string; stars: number; url: string }[];
};

const DEFAULT_QUERIES = [
  'topic:robot-learning sort:stars-desc',
  'topic:robotics topic:manipulation sort:stars-desc',
  'topic:imitation-learning sort:stars-desc',
  'manipulation robot policy in:readme stars:>50 sort:stars-desc',
  'humanoid robot teleoperation in:readme stars:>50 sort:stars-desc',
  'vision-language-action robot stars:>30 sort:stars-desc',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const scanGithubOrgs = async (
  opts: { queries?: string[]; maxOrgs?: number } = {},
): Promise<GithubOrgHit[]> => {
  const queries = opts.queries ?? DEFAULT_QUERIES;
  console.log(`[stage1:scan-github] ${queries.length} queries`);

  const orgs = new Map<string, { repoCount: number; totalStars: number; samples: SearchRepoItem[] }>();
  for (const q of queries) {
    try {
      const items = await searchRepos(q, 50, 1);
      console.log(`  [${q}] → ${items.length} repos`);
      for (const item of items) {
        if (item.owner.type !== 'Organization') continue;
        const login = item.owner.login.toLowerCase();
        if (KNOWN_OWNERS.has(login)) continue;
        let bucket = orgs.get(login);
        if (!bucket) {
          bucket = { repoCount: 0, totalStars: 0, samples: [] };
          orgs.set(login, bucket);
        }
        bucket.repoCount += 1;
        bucket.totalStars += item.stargazers_count;
        if (bucket.samples.length < 3) bucket.samples.push(item);
      }
    } catch (err) {
      console.warn(`[stage1:scan-github] query "${q}" failed:`, err instanceof Error ? err.message : err);
    }
    await sleep(800);
  }

  console.log(`[stage1:scan-github] ${orgs.size} candidate orgs before name filter`);

  // Hydrate top candidates with org-page metadata.
  const sorted = [...orgs.entries()].sort((a, b) => b[1].totalStars - a[1].totalStars);
  const hits: GithubOrgHit[] = [];
  const maxToHydrate = opts.maxOrgs ?? 40;
  for (const [login, bucket] of sorted.slice(0, maxToHydrate)) {
    if (isLikelyMegaOrgNoise(bucket.totalStars, bucket.repoCount)) continue;
    try {
      const user = await fetchUser(login);
      if (knownByOrgName(login, user?.name ?? null)) continue;
      if (!looksRoboticsRelevant(user?.name, user?.bio)) continue;
      hits.push({
        login,
        ...(user?.name && { name: user.name }),
        ...(user?.blog && { blog: user.blog }),
        ...(user?.location && { location: user.location }),
        ...(user?.bio && { description: user.bio }),
        repoCount: bucket.repoCount,
        totalStars: bucket.totalStars,
        sampleRepos: bucket.samples.map((s) => ({
          fullName: s.full_name,
          stars: s.stargazers_count,
          url: s.html_url,
        })),
      });
    } catch {
      // Skip orgs whose details we can't load.
    }
    await sleep(250);
  }

  hits.sort((a, b) => b.totalStars - a.totalStars);
  console.log(`[stage1:scan-github] done — ${hits.length} hydrated candidates`);
  return hits;
};

const main = async () => {
  const args = process.argv.slice(2);
  const max = Number(args.find((a) => a.startsWith('--max='))?.replace('--max=', '') ?? '40');
  const hits = await scanGithubOrgs({ maxOrgs: max });

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = path.join(STATE_DIR, 'scan-github-orgs.json');
  fs.writeFileSync(out, JSON.stringify(hits, null, 2), 'utf-8');
  console.log(`[stage1:scan-github] wrote ${hits.length} hits → ${out}`);

  console.log('\nTop 10:');
  for (const h of hits.slice(0, 10)) {
    console.log(
      `  ${String(h.totalStars).padStart(5)}★  ${h.login.padEnd(28)} ${(h.name ?? '').slice(0, 30)}  ${(h.blog ?? '').slice(0, 30)}`,
    );
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
