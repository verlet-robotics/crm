// L1 discovery — GitHub contributor crawler.
//
// Engineers at humanoid co's commit to LeRobot/OpenPI/Diffusion-Policy/Octo/
// MimicGen even when their company never publishes a paper. This is the only
// discovery path that surfaces them.
//
// Flow per repo:
//   1. List top contributors (100 max per repo).
//   2. For each non-bot login, fetch the user profile.
//   3. Try to match the user to one of our targets via:
//        a. `email` domain (rare but high-confidence when present)
//        b. `company` field normalized + substring-matched against
//           ICP_COMPANIES.name OR INSTITUTION_ALLOWLIST.matchers.
//   4. On match, upsert the Company and upsert the Person with
//      discoverySource=GITHUB, discoveryRef=https://github.com/<login>.
//
// Misses are logged via logUnmatched so the suggester can flag often-seen
// company strings we haven't covered.
import 'dotenv/config';

import {
  upsertCompanyByDomain,
  upsertPersonFromDiscovery,
} from '../lib/twenty-client.js';

import { fetchUser, type GhUser, listContributors } from './github.js';
import {
  ensureInstitutionCompany,
  logUnmatched,
  matchInstitution,
} from './match-institution.js';
import {
  type IcpCompany,
  ICP_COMPANIES,
  ROBOTICS_REPOS,
} from './sources.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Stats = {
  contributors: number;
  resolved: number;
  matchedIcp: number;
  matchedInstitution: number;
  unmatched: number;
  created: number;
  skipped: number;
  errors: number;
};

// Normalize a GitHub `company` string: trim, strip leading @, lowercase.
const normalizeCompany = (raw: string): string =>
  raw.replace(/^@/, '').trim().toLowerCase();

// Try to find an ICP_COMPANY whose name (lowercased) appears as a substring
// of the normalized GH company OR whose domain matches the email domain.
const matchIcp = (user: GhUser): IcpCompany | null => {
  const email = user.email?.toLowerCase();
  if (email) {
    const at = email.lastIndexOf('@');
    if (at > 0) {
      const domain = email.slice(at + 1);
      const byDomain = ICP_COMPANIES.find((c) => c.domain === domain);
      if (byDomain) return byDomain;
    }
  }
  if (!user.company) return null;
  const norm = normalizeCompany(user.company);
  // Sort by name length descending so 'physical intelligence' wins over
  // a hypothetical 'pi' entry.
  const sorted = [...ICP_COMPANIES].sort((a, b) => b.name.length - a.name.length);
  for (const co of sorted) {
    if (norm.includes(co.name.toLowerCase())) return co;
    // Also match against the bare domain root (e.g. user.company='figure.ai'
    // when someone fills the slot with their URL).
    const domainRoot = co.domain.split('.')[0];
    if (domainRoot.length >= 4 && norm.includes(domainRoot)) return co;
  }
  return null;
};

// Split a GH `name` (may be "Pieter Abbeel" or "Pieter") into first/last.
const splitName = (full: string): { firstName: string; lastName: string } | null => {
  const cleaned = full.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
};

export const discoverFromGithub = async (
  opts: { dryRun?: boolean; perRepoLimit?: number } = {},
): Promise<Stats> => {
  const stats: Stats = {
    contributors: 0,
    resolved: 0,
    matchedIcp: 0,
    matchedInstitution: 0,
    unmatched: 0,
    created: 0,
    skipped: 0,
    errors: 0,
  };
  const seenLogins = new Set<string>();
  const perRepoLimit = opts.perRepoLimit ?? 50;

  if (!process.env.GITHUB_TOKEN) {
    console.warn(
      '[discover:github] no GITHUB_TOKEN — unauthenticated rate limit is 60 req/h. Set GITHUB_TOKEN in Doppler.',
    );
  }

  for (const repo of ROBOTICS_REPOS) {
    console.log(`[discover:github] ${repo.owner}/${repo.repo}`);
    let contributors;
    try {
      contributors = await listContributors(repo.owner, repo.repo, perRepoLimit);
    } catch (err) {
      console.warn(`[discover:github] list failed ${repo.owner}/${repo.repo}:`, err);
      stats.errors += 1;
      continue;
    }
    console.log(`  → ${contributors.length} contributors`);
    stats.contributors += contributors.length;

    for (const c of contributors) {
      if (seenLogins.has(c.login)) continue;
      seenLogins.add(c.login);

      try {
        const user = await fetchUser(c.login);
        await sleep(250); // pace at ~4 req/sec; well under the authed limit
        if (!user) continue;
        stats.resolved += 1;

        const icp = matchIcp(user);
        if (icp) {
          stats.matchedIcp += 1;
          await ingestPerson(user, { kind: 'icp', target: icp }, stats, opts.dryRun);
          continue;
        }

        // Fall back to institution match against the company field.
        if (user.company) {
          const inst = matchInstitution(user.company);
          if (inst) {
            stats.matchedInstitution += 1;
            await ingestPerson(user, { kind: 'institution', target: inst }, stats, opts.dryRun);
            continue;
          }
        }

        stats.unmatched += 1;
        if (user.company) {
          // The `company` field is the affiliation signal here, not the
          // typical "affiliation" string we'd get from S2 — but the report
          // logic is the same.
          logUnmatched(user.company, 'arxiv', {
            authorName: user.name ?? user.login,
            paperUrl: user.htmlUrl,
          });
        }
      } catch (err) {
        console.warn(`[discover:github] user ${c.login} failed:`, err);
        stats.errors += 1;
      }
    }
  }
  return stats;
};

type MatchTarget =
  | { kind: 'icp'; target: IcpCompany }
  | { kind: 'institution'; target: ReturnType<typeof matchInstitution> & object };

const ingestPerson = async (
  user: GhUser,
  match: MatchTarget,
  stats: Stats,
  dryRun?: boolean,
): Promise<void> => {
  if (!user.name) {
    // GH names are optional — fall back to login but only if it looks like a
    // real name. Skip pure-handle logins (no whitespace, all-lowercase, etc.)
    // to avoid creating Person rows like "Tonyzhaozh tonyzhaozh".
    stats.skipped += 1;
    return;
  }
  const split = splitName(user.name);
  if (!split || !split.firstName) {
    stats.skipped += 1;
    return;
  }

  const label = match.kind === 'icp' ? match.target.name : match.target.name;
  if (dryRun) {
    console.log(`  + ${split.firstName} ${split.lastName} @ ${label} (gh/${user.login})`);
    stats.created += 1;
    return;
  }

  let companyId: string;
  if (match.kind === 'icp') {
    const co = await upsertCompanyByDomain({
      name: match.target.name,
      domainName: match.target.domain,
      accountType: 'COMPANY',
      idealCustomerProfile: true,
    });
    companyId = co.id;
  } else {
    const co = await ensureInstitutionCompany(match.target);
    companyId = co.id;
  }

  const result = await upsertPersonFromDiscovery({
    firstName: split.firstName,
    lastName: split.lastName,
    ...(user.email && { primaryEmail: user.email }),
    companyId,
    discoverySource: 'GITHUB',
    discoveryRef: user.htmlUrl,
  });
  if (result.created) {
    stats.created += 1;
    console.log(`  + ${split.firstName} ${split.lastName} @ ${label} (gh/${user.login})`);
  } else {
    stats.skipped += 1;
  }
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await discoverFromGithub({ dryRun });
  console.log('[discover:github] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
