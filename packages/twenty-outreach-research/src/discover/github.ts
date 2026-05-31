// Minimal GitHub REST client for the contributor crawler.
//
// Two endpoints used:
//   1. GET /repos/{owner}/{repo}/contributors?per_page=100
//   2. GET /users/{login}
//
// Unauthenticated rate limit: 60 req/h. Set GITHUB_TOKEN (any classic PAT or
// fine-grained token with no scopes — public-only access is enough) to lift
// to 5000 req/h. The crawler errs visibly with a hint if the limit hits.

const GITHUB_API = 'https://api.github.com';

const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'verlet-outreach-research/0.1',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
};

const ghFetch = async <T>(pathSuffix: string): Promise<T> => {
  const url = `${GITHUB_API}${pathSuffix}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 403) {
    const reset = res.headers.get('x-ratelimit-reset');
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      `GitHub rate-limited (remaining=${remaining}, reset=${reset}). ` +
        `Set GITHUB_TOKEN in Doppler to lift the limit to 5000/h.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub ${url} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
};

export type GhContributor = {
  login: string;
  contributions: number;
};

export const listContributors = async (
  owner: string,
  repo: string,
  perPage = 100,
): Promise<GhContributor[]> => {
  type RawContributor = { login: string | null; contributions: number; type?: string };
  const raw = await ghFetch<RawContributor[]>(
    `/repos/${owner}/${repo}/contributors?per_page=${perPage}&anon=false`,
  );
  return raw
    // GitHub Actions / Dependabot show up as User but with bot-like logins;
    // filter the obvious ones. Real bot accounts have type='Bot'.
    .filter((c): c is RawContributor & { login: string } =>
      !!c.login && c.type !== 'Bot' && !/\[bot\]$/.test(c.login),
    )
    .map((c) => ({ login: c.login, contributions: c.contributions }));
};

export type GhUser = {
  login: string;
  name?: string;
  company?: string;
  email?: string;
  blog?: string;
  bio?: string;
  location?: string;
  htmlUrl: string;
};

export const fetchUser = async (login: string): Promise<GhUser | null> => {
  type RawUser = {
    login: string;
    name?: string | null;
    company?: string | null;
    email?: string | null;
    blog?: string | null;
    bio?: string | null;
    location?: string | null;
    html_url: string;
  };
  try {
    const u = await ghFetch<RawUser>(`/users/${login}`);
    return {
      login: u.login,
      ...(u.name && { name: u.name }),
      ...(u.company && { company: u.company }),
      ...(u.email && { email: u.email }),
      ...(u.blog && { blog: u.blog }),
      ...(u.bio && { bio: u.bio }),
      ...(u.location && { location: u.location }),
      htmlUrl: u.html_url,
    };
  } catch (err) {
    if (err instanceof Error && /404/.test(err.message)) return null;
    throw err;
  }
};
