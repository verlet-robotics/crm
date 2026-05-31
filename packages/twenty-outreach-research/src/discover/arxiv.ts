// arXiv API client. arXiv exposes a query endpoint that returns Atom XML; we
// parse it with fast-xml-parser. No API key required.
import { XMLParser } from 'fast-xml-parser';

const ARXIV_BASE = 'https://export.arxiv.org/api/query';

export type ArxivAuthor = {
  name: string;
  // arXiv author entries occasionally include `arxiv:affiliation`. When present,
  // we capture it. Most submissions omit it, so callers should plan to look up
  // affiliations elsewhere (Semantic Scholar) for the un-affiliated.
  affiliation?: string;
};

export type ArxivPaper = {
  id: string;
  url: string;
  title: string;
  abstract: string;
  published: string;
  updated: string;
  authors: ArxivAuthor[];
  primaryCategory: string;
  categories: string[];
};

type AtomEntry = {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  author:
    | { name: string; 'arxiv:affiliation'?: string }
    | { name: string; 'arxiv:affiliation'?: string }[];
  category: { '@_term': string } | { '@_term': string }[];
  'arxiv:primary_category'?: { '@_term': string };
};

type AtomFeed = { feed: { entry?: AtomEntry | AtomEntry[] } };

const xml = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  trimValues: true,
});

const arr = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const searchArxiv = async (opts: {
  categories: readonly string[];
  keywords: readonly string[];
  startDays: number;
  maxResults?: number;
}): Promise<ArxivPaper[]> => {
  // arXiv's API doesn't support a true date range filter, but it lets us sort
  // by submittedDate and we filter client-side. We also AND a category filter
  // and OR over keywords.
  const catClause = opts.categories.map((c) => `cat:${c}`).join('+OR+');
  const keywordClause = opts.keywords
    .map((k) => `abs:%22${encodeURIComponent(k)}%22`)
    .join('+OR+');
  const query = `(${catClause})+AND+(${keywordClause})`;
  const url = `${ARXIV_BASE}?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=${opts.maxResults ?? 200}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'verlet-outreach-research/0.1 (mateo@verlet.com)' },
  });
  if (!response.ok) {
    throw new Error(`arXiv → ${response.status} ${await response.text()}`);
  }
  const body = await response.text();
  const parsed = xml.parse(body) as AtomFeed;
  const entries = arr(parsed.feed?.entry);

  const cutoff = new Date(Date.now() - opts.startDays * 24 * 3600 * 1000);

  const papers: ArxivPaper[] = entries
    .map((e): ArxivPaper => {
      const cats = arr(e.category).map((c) => c['@_term']);
      return {
        id: e.id,
        url: e.id,
        title: clean(e.title),
        abstract: clean(e.summary),
        published: e.published,
        updated: e.updated,
        primaryCategory: e['arxiv:primary_category']?.['@_term'] ?? cats[0] ?? '',
        categories: cats,
        authors: arr(e.author).map((a) => ({
          name: clean(a.name),
          ...(a['arxiv:affiliation'] && { affiliation: clean(a['arxiv:affiliation']) }),
        })),
      };
    })
    .filter((p) => new Date(p.published) >= cutoff);

  return papers;
};
