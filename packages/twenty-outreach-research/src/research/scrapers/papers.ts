// Semantic Scholar paper lookup. Free, no API key required (but rate-limited to
// ~100 req/5min unguarded; if SEMANTIC_SCHOLAR_API_KEY is set, we send it as an
// x-api-key header for a higher quota).
//
// Strategy:
//   1. Search authors by name.
//   2. If multiple hits, disambiguate by affiliation string match.
//   3. Fetch papers for the chosen author, newest first.
const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;

const s2Fetch = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${S2_BASE}${path}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  });
  if (!response.ok) {
    throw new Error(`Semantic Scholar ${path} → ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
};

type S2Author = { authorId: string; name: string; affiliations?: string[] };

const matchScore = (haystack: string, needle: string): number => {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return n.length;
  const tokens = n.split(/\s+/).filter((t) => t.length > 2);
  return tokens.filter((t) => h.includes(t)).length;
};

export const findAuthor = async (
  name: string,
  affiliation: string,
): Promise<S2Author | null> => {
  const search = await s2Fetch<{ data: S2Author[] }>(
    `/author/search?query=${encodeURIComponent(name)}&limit=10&fields=name,affiliations`,
  );
  const candidates = search.data ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const scored = candidates
    .map((c) => ({
      author: c,
      score: matchScore((c.affiliations ?? []).join(' '), affiliation),
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0].author;
};

export type S2Paper = {
  title: string;
  year: number;
  venue?: string;
  abstract?: string;
  url?: string;
};

type S2PaperRaw = {
  title: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  externalIds?: Record<string, string>;
  url?: string;
};

export const fetchRecentPapers = async (
  authorId: string,
  limit = 5,
): Promise<S2Paper[]> => {
  // The S2 /author/{id}/papers endpoint returns each paper directly (no
  // `.paper` wrapper); earlier code assumed a wrapper which silently broke.
  const res = await s2Fetch<{ data: S2PaperRaw[] }>(
    `/author/${authorId}/papers?limit=${limit}&fields=title,year,venue,abstract,externalIds,url`,
  );
  return (res.data ?? [])
    .filter((p): p is S2PaperRaw & { title: string; year: number } =>
      !!p && !!p.title && !!p.year,
    )
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, limit)
    .map((p) => ({
      title: p.title,
      year: p.year,
      ...(p.venue && { venue: p.venue }),
      ...(p.abstract && { abstract: p.abstract }),
      ...(p.url
        ? { url: p.url }
        : p.externalIds?.DOI
          ? { url: `https://doi.org/${p.externalIds.DOI}` }
          : p.externalIds?.ArXiv
            ? { url: `https://arxiv.org/abs/${p.externalIds.ArXiv}` }
            : {}),
    }));
};

export const fetchPapersForTarget = async (
  name: string,
  affiliation: string,
  limit = 5,
): Promise<S2Paper[]> => {
  const author = await findAuthor(name, affiliation);
  if (!author) return [];
  return fetchRecentPapers(author.authorId, limit);
};

// Fetch an author's affiliations by ID. Used by the academic Stage 2 finder
// to cross-reference S2 co-authors against the target institution — filters
// out external collaborators (e.g. Ken Goldberg appearing on a Yuke Zhu paper
// because of a one-off collaboration; Goldberg is at Berkeley, not UT).
//
// Returns null on failure (rate limit, 404). Empty array is a valid response
// — S2 doesn't have affiliation data for every author. Callers should treat
// "no data" as ambiguous, not as a rejection.
export const fetchAuthorAffiliations = async (
  authorId: string,
): Promise<string[] | null> => {
  try {
    const res = await s2Fetch<{ affiliations?: string[] }>(
      `/author/${authorId}?fields=affiliations`,
    );
    return res.affiliations ?? [];
  } catch {
    return null;
  }
};

// Variant of fetchRecentPapers that includes per-paper author lists with
// affiliations — used by the academic Stage 2 finder to walk one hop out from
// a PI to their grad students + postdoc co-authors.
export type S2PaperWithCoauthors = S2Paper & {
  // affiliations omitted — S2 doesn't return them from /author/{id}/papers.
  // For affiliation cross-reference, dedup against lab-roster scrape instead.
  authors: { authorId?: string; name: string }[];
};

export const fetchRecentPapersWithCoauthors = async (
  authorId: string,
  limit = 8,
): Promise<S2PaperWithCoauthors[]> => {
  // NOTE: S2's /author/{id}/papers endpoint does NOT accept `authors.affiliations`
  // in the fields param (returns 400 "Unrecognized or unsupported fields"). Per-author
  // affiliations are only available via a separate /author/{authorId} fetch. Caller
  // should rely on dedup against lab-roster scrape for affiliation cross-reference.
  type Raw = S2PaperRaw & {
    authors?: { authorId?: string; name: string }[];
  };
  const res = await s2Fetch<{ data: Raw[] }>(
    `/author/${authorId}/papers?limit=${limit}&fields=title,year,venue,abstract,externalIds,url,authors.name,authors.authorId`,
  );
  return (res.data ?? [])
    .filter((p): p is Raw & { title: string; year: number } => !!p && !!p.title && !!p.year)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, limit)
    .map((p) => ({
      title: p.title,
      year: p.year,
      ...(p.venue && { venue: p.venue }),
      ...(p.abstract && { abstract: p.abstract }),
      ...(p.url
        ? { url: p.url }
        : p.externalIds?.DOI
          ? { url: `https://doi.org/${p.externalIds.DOI}` }
          : p.externalIds?.ArXiv
            ? { url: `https://arxiv.org/abs/${p.externalIds.ArXiv}` }
            : {}),
      authors: (p.authors ?? []).filter((a) => !!a?.name),
    }));
};

// Citation graph — papers that cite the given paperId. paperId follows S2's
// convention: 'arXiv:2410.07864', 'DOI:10.1109/ICRA.2024.12345', or a raw
// S2 paperId. Returns the citing papers with their authors + (when present)
// affiliations — letting us walk one-hop out from a seed paper to surface
// researchers actively building on that seed.
export type S2CitingPaper = {
  paperId: string;
  title: string;
  year?: number;
  url?: string;
  arxivId?: string;
  authors: { authorId?: string; name: string; affiliations?: string[] }[];
};

export const fetchCitations = async (
  paperId: string,
  limit = 100,
): Promise<S2CitingPaper[]> => {
  const fields = [
    'citingPaper.paperId',
    'citingPaper.title',
    'citingPaper.year',
    'citingPaper.url',
    'citingPaper.externalIds',
    'citingPaper.authors.name',
    'citingPaper.authors.authorId',
    'citingPaper.authors.affiliations',
  ].join(',');
  type Raw = {
    data: {
      citingPaper: {
        paperId: string;
        title: string | null;
        year: number | null;
        url?: string;
        externalIds?: Record<string, string>;
        authors?: { authorId?: string; name: string; affiliations?: string[] }[];
      };
    }[];
  };
  const res = await s2Fetch<Raw>(
    `/paper/${encodeURIComponent(paperId)}/citations?fields=${fields}&limit=${limit}`,
  );
  return (res.data ?? [])
    .map((d) => d.citingPaper)
    .filter((p): p is Raw['data'][number]['citingPaper'] & { title: string } => !!p?.title)
    .map((p) => ({
      paperId: p.paperId,
      title: p.title,
      ...(p.year != null && { year: p.year }),
      ...(p.url && { url: p.url }),
      ...(p.externalIds?.ArXiv && { arxivId: p.externalIds.ArXiv }),
      authors: (p.authors ?? []).filter((a) => !!a?.name),
    }));
};
