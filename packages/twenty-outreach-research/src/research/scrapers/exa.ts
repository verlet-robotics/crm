// Exa neural-search scraper. Provides three primitives:
//   1. searchNews — recent news/blog mentions of a target (last 90 days default).
//   2. searchSocial — recent forum/twitter/substack content about a target.
//   3. findSimilarResearchers — given a paper title or URL, surface adjacent
//      researchers whose recent work cites or resembles it. Used by L1 discovery.
//
// Uses the official Exa REST API; no SDK dependency to keep this package light.
const EXA_BASE = 'https://api.exa.ai';

const apiKey = (): string => {
  // Doppler convention is EXA_SEARCH_API_KEY (more descriptive — Exa has
  // search + contents + findSimilar products). Falls back to EXA_API_KEY for
  // anyone copying from the official Exa docs.
  const key = process.env.EXA_SEARCH_API_KEY ?? process.env.EXA_API_KEY;
  if (!key) throw new Error('EXA_SEARCH_API_KEY (or EXA_API_KEY) is not set');
  return key;
};

type ExaSearchResult = {
  title: string;
  url: string;
  publishedDate?: string;
  text?: string;
  highlights?: string[];
  author?: string;
};

type ExaSearchResponse = { results: ExaSearchResult[] };

const exaSearch = async (
  query: string,
  opts: {
    type?: 'neural' | 'keyword' | 'auto';
    numResults?: number;
    startPublishedDate?: string;
    includeDomains?: string[];
    excludeDomains?: string[];
    includeText?: boolean;
  } = {},
): Promise<ExaSearchResult[]> => {
  const response = await fetch(`${EXA_BASE}/search`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      type: opts.type ?? 'auto',
      numResults: opts.numResults ?? 8,
      ...(opts.startPublishedDate && { startPublishedDate: opts.startPublishedDate }),
      ...(opts.includeDomains && { includeDomains: opts.includeDomains }),
      ...(opts.excludeDomains && { excludeDomains: opts.excludeDomains }),
      ...(opts.includeText && {
        contents: { text: { maxCharacters: 2000 }, highlights: { numSentences: 3 } },
      }),
    }),
  });
  if (!response.ok) {
    throw new Error(`Exa search → ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as ExaSearchResponse;
  return body.results ?? [];
};

export type NewsHit = {
  title: string;
  date: string;
  source: string;
  summary: string;
  url: string;
};

const daysAgoIso = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export const searchNews = async (
  name: string,
  affiliation: string,
  windowDays = 365,
): Promise<NewsHit[]> => {
  const query = `"${name}" ${affiliation} robotics manipulation`;
  const results = await exaSearch(query, {
    type: 'neural',
    numResults: 6,
    startPublishedDate: daysAgoIso(windowDays),
    includeText: true,
    excludeDomains: ['twitter.com', 'x.com', 'reddit.com'],
  });
  return results
    .filter((r) => r.publishedDate)
    .map((r) => ({
      title: r.title,
      date: (r.publishedDate ?? '').split('T')[0],
      source: domainOf(r.url),
      summary: (r.highlights ?? []).join(' ') || (r.text ?? '').slice(0, 280),
      url: r.url,
    }));
};

export type SocialHit = {
  date: string;
  text: string;
  url: string;
};

export const searchSocial = async (
  name: string,
  twitterHandle?: string,
): Promise<SocialHit[]> => {
  const query = twitterHandle
    ? `@${twitterHandle} OR "${name}" robotics`
    : `"${name}" robotics manipulation`;
  const results = await exaSearch(query, {
    type: 'neural',
    numResults: 5,
    startPublishedDate: daysAgoIso(180),
    includeDomains: ['x.com', 'twitter.com', 'substack.com', 'medium.com'],
    includeText: true,
  });
  return results
    .filter((r) => r.publishedDate)
    .map((r) => ({
      date: (r.publishedDate ?? '').split('T')[0],
      text: (r.highlights ?? []).join(' ') || (r.text ?? '').slice(0, 280),
      url: r.url,
    }));
};

// LinkedIn profile search. Pure keyword search restricted to linkedin.com/in.
// Exa's keyword type works better than neural for this kind of structured
// site-scoped lookup. Result.title typically looks like
// "Firstname Lastname - Title at Company | LinkedIn" — we parse name + title.
export type LinkedInProfileHit = {
  firstName?: string;
  lastName?: string;
  title?: string;
  url: string;
  raw: string;
};

const parseLinkedInTitle = (
  raw: string,
  companyName?: string,
): { firstName?: string; lastName?: string; title?: string } => {
  // LinkedIn URL preview titles vary:
  //   "Name - Title - Company | LinkedIn"
  //   "Name - Title at Company | LinkedIn"
  //   "Name - Company - LinkedIn"   (NO PIPE — older / mobile preview)
  //   "Name | LinkedIn"
  // Strip BOTH "| LinkedIn" and "- LinkedIn" tails.
  let cleaned = raw.replace(/\s*[|·]\s*LinkedIn.*$/i, '');
  cleaned = cleaned.replace(/\s+[-–]\s*LinkedIn\s*$/i, '');
  cleaned = cleaned.trim();

  const dashSplit = cleaned.split(/\s+[-–]\s+/);
  if (dashSplit.length >= 2) {
    const [namePart, ...rest] = dashSplit;
    const nameTokens = namePart.trim().split(/\s+/);
    if (nameTokens.length >= 2) {
      let title = rest.join(' - ').trim();
      // "Title at Company" → strip the "at Company" tail so we keep the role.
      if (companyName) {
        const atRe = new RegExp(`\\s+at\\s+${companyName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}.*$`, 'i');
        title = title.replace(atRe, '').trim();
      }
      // If title is just the company name (or empty), drop it — that's not
      // a job title, that's the LinkedIn URL preview leaking the org name.
      if (companyName && title.toLowerCase() === companyName.toLowerCase()) {
        title = '';
      }
      return {
        firstName: nameTokens[0],
        lastName: nameTokens.slice(1).join(' '),
        ...(title && { title }),
      };
    }
  }
  const tokens = cleaned.split(/\s+/);
  if (tokens.length >= 2) {
    return { firstName: tokens[0], lastName: tokens[1] };
  }
  return {};
};

export const searchLinkedInProfiles = async (
  companyName: string,
  titleKeywords: string[],
  numResults = 15,
): Promise<LinkedInProfileHit[]> => {
  // OR'd title keywords inside quotes to keep the phrase tight; company name
  // outside to match either current or past employment text.
  const titlesClause = titleKeywords.map((t) => `"${t}"`).join(' OR ');
  const query = `${titlesClause} ${companyName} site:linkedin.com/in`;
  const results = await exaSearch(query, {
    type: 'keyword',
    numResults,
    includeDomains: ['linkedin.com'],
  });
  // Post-filter: require the result title or snippet to mention the target
  // company name. Exa's keyword OR matches loosely so without this we get
  // "Head of AI at Elevate Robotics" coming back for a Sereact search.
  const companyLower = companyName.toLowerCase();
  return results
    .filter((r) => r.url.includes('linkedin.com/in/'))
    .filter((r) => {
      const haystack = `${r.title} ${r.text ?? ''}`.toLowerCase();
      return haystack.includes(companyLower);
    })
    .map((r) => {
      const parsed = parseLinkedInTitle(r.title, companyName);
      return {
        ...parsed,
        url: r.url,
        raw: r.title,
      };
    });
};

// General neural web search for the agentic role-finder. Unlike searchNews,
// this does NOT filter on publishedDate — org-chart / team / "leadership" pages
// (TheOrg, company /about, conference speaker bios) usually have no publish
// date and would be dropped. Returns page text + highlights for LLM extraction.
export type WebHit = {
  title: string;
  url: string;
  text: string;
  highlights: string[];
};

export const searchWeb = async (
  query: string,
  opts: { numResults?: number; includeDomains?: string[]; excludeDomains?: string[] } = {},
): Promise<WebHit[]> => {
  const results = await exaSearch(query, {
    type: 'auto',
    numResults: opts.numResults ?? 6,
    includeText: true,
    ...(opts.includeDomains && { includeDomains: opts.includeDomains }),
    ...(opts.excludeDomains && { excludeDomains: opts.excludeDomains }),
  });
  return results.map((r) => ({
    title: r.title,
    url: r.url,
    text: (r.text ?? '').slice(0, 2000),
    highlights: r.highlights ?? [],
  }));
};

export const findSimilarPapers = async (
  paperUrl: string,
  numResults = 6,
): Promise<ExaSearchResult[]> => {
  const response = await fetch(`${EXA_BASE}/findSimilar`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: paperUrl,
      numResults,
      excludeSourceDomain: false,
      contents: { text: { maxCharacters: 1000 } },
    }),
  });
  if (!response.ok) {
    throw new Error(`Exa findSimilar → ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as ExaSearchResponse;
  return body.results ?? [];
};
