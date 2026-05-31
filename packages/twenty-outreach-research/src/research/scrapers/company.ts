// Company-signal scraper. Pulls funding rounds, recent hires, product launches
// and (optionally, via GitHub) eng-team signals for commercial targets.
//
// Implementation strategy:
//   - For funding/news/launches: Exa neural search with date filter, then
//     dedupe by URL and let the L2 synthesizer triage relevance from the snippets.
//   - For GitHub: query the public Search API for recent activity in known
//     robotics repos; surfaces engineering-level decision-makers at AI labs that
//     don't publish team pages (Physical Intelligence, Skild AI, etc.).
import { searchNews } from './exa.js';

export type CompanySignals = {
  funding: { round: string; amount: string; date: string }[];
  hiring: { role: string; date: string; url?: string }[];
  products: { name: string; date: string; summary: string }[];
};

export const fetchCompanySignals = async (
  companyName: string,
  domain?: string,
): Promise<CompanySignals> => {
  const [funding, hiring, products] = await Promise.all([
    fetchFunding(companyName),
    fetchHiring(companyName, domain),
    fetchProducts(companyName),
  ]);
  return { funding, hiring, products };
};

const fetchFunding = async (
  companyName: string,
): Promise<CompanySignals['funding']> => {
  const hits = await searchNews(companyName, 'funding round Series', 540);
  // The L2 synthesizer extracts round + amount from the title+summary text we
  // pack into the `round` field; `amount` left empty unless we can pull a
  // dollar figure with a quick regex.
  const dollarMatch = (s: string): string => {
    const m = s.match(/\$\s?[\d.]+\s?(?:million|billion|M|B|m|b)?/i);
    return m ? m[0] : '';
  };
  return hits.slice(0, 4).map((h) => ({
    round: `${h.title} — ${h.summary}`,
    amount: dollarMatch(`${h.title} ${h.summary}`),
    date: h.date,
  }));
};

const fetchHiring = async (
  companyName: string,
  domain?: string,
): Promise<CompanySignals['hiring']> => {
  const hits = await searchNews(
    companyName,
    domain ? `careers ${domain} hiring engineering data` : 'hiring engineering data',
    180,
  );
  return hits.slice(0, 4).map((h) => ({
    role: h.title,
    date: h.date,
    url: h.url,
  }));
};

const fetchProducts = async (
  companyName: string,
): Promise<CompanySignals['products']> => {
  const hits = await searchNews(companyName, 'launch product announcement release', 365);
  return hits.slice(0, 4).map((h) => ({
    name: h.title,
    date: h.date,
    summary: h.summary,
  }));
};

// GitHub eng-team signal — given a list of "robotics open-source repos that
// matter" (LeRobot, OpenPI, RT-X tooling, etc.), find recent committers whose
// GitHub bio or email implies they work at the target company.
//
// Optional auth via GITHUB_TOKEN raises the rate limit from 60/hr to 5000/hr.
const GITHUB_BASE = 'https://api.github.com';

const ghHeaders = (): Record<string, string> => {
  const token = process.env.GITHUB_TOKEN;
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
};

export type GithubContributor = {
  login: string;
  name?: string;
  email?: string;
  company?: string;
  bio?: string;
  htmlUrl: string;
};

const ROBOTICS_REPOS = [
  'huggingface/lerobot',
  'openpi/openpi',
  'kscalelabs/ksim',
  'physical-intelligence/openpi',
];

export const findEngineersAtCompany = async (
  companyName: string,
): Promise<GithubContributor[]> => {
  const found: GithubContributor[] = [];
  for (const repo of ROBOTICS_REPOS) {
    try {
      const commitsRes = await fetch(
        `${GITHUB_BASE}/repos/${repo}/commits?per_page=30`,
        { headers: ghHeaders() },
      );
      if (!commitsRes.ok) continue;
      const commits = (await commitsRes.json()) as {
        author?: { login?: string; html_url?: string } | null;
      }[];
      const logins = new Set(
        commits.map((c) => c.author?.login).filter((l): l is string => !!l),
      );

      for (const login of logins) {
        const userRes = await fetch(`${GITHUB_BASE}/users/${login}`, {
          headers: ghHeaders(),
        });
        if (!userRes.ok) continue;
        const user = (await userRes.json()) as {
          login: string;
          name?: string;
          email?: string;
          company?: string;
          bio?: string;
          html_url: string;
        };
        const haystack = `${user.company ?? ''} ${user.bio ?? ''} ${user.email ?? ''}`.toLowerCase();
        if (haystack.includes(companyName.toLowerCase())) {
          found.push({
            login: user.login,
            ...(user.name && { name: user.name }),
            ...(user.email && { email: user.email }),
            ...(user.company && { company: user.company }),
            ...(user.bio && { bio: user.bio }),
            htmlUrl: user.html_url,
          });
        }
      }
    } catch {
      // Best-effort; one repo failing shouldn't kill the whole scan.
    }
  }
  // Dedupe by login
  const seen = new Set<string>();
  return found.filter((c) => {
    if (seen.has(c.login)) return false;
    seen.add(c.login);
    return true;
  });
};
