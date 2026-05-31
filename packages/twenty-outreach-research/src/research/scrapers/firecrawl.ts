// Firecrawl scraper. Two primitives:
//   1. extractLabPage — typed JSON extraction over a PI lab/homepage URL using
//      a Zod-like JSON schema. This is the "advanced" pattern — LLM extraction
//      runs INSIDE Firecrawl so we get clean typed output, not raw HTML.
//   2. scrapeMarkdown — fallback for generic pages where we just want markdown.
//
// Uses Firecrawl's REST API directly to avoid an SDK dependency.
const FIRECRAWL_BASE = 'https://api.firecrawl.dev';

const apiKey = (): string => {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set');
  return key;
};

export type LabPageExtract = {
  labName?: string;
  pi?: string;
  focusAreas?: string[];
  currentProjects?: string[];
  studentsCount?: number;
  equipment?: string[];
  recentNews?: string[];
  fundingSources?: string[];
  contactEmail?: string;
};

const labPageSchema = {
  type: 'object',
  properties: {
    labName: { type: 'string', description: 'Name of the lab or research group.' },
    pi: { type: 'string', description: 'Principal investigator.' },
    focusAreas: {
      type: 'array',
      items: { type: 'string' },
      description: 'Research focus areas (e.g. imitation learning, sim-to-real).',
    },
    currentProjects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Active projects listed on the page, with one-line descriptions.',
    },
    studentsCount: { type: 'number', description: 'Approximate number of students/postdocs.' },
    equipment: {
      type: 'array',
      items: { type: 'string' },
      description: 'Robotic platforms or hardware mentioned (e.g. ALOHA, Franka, Unitree H1).',
    },
    recentNews: {
      type: 'array',
      items: { type: 'string' },
      description: 'News, awards, or recent announcements from the lab.',
    },
    fundingSources: {
      type: 'array',
      items: { type: 'string' },
      description: 'Funders (NSF, ONR, TRI, DARPA, etc.).',
    },
    contactEmail: { type: 'string', description: 'PI email if listed.' },
  },
};

// Shared JSON-extraction primitive over /v2/scrape. Firecrawl deprecated the
// old /v1/extract (async-job, `urls` array, top-level `schema`/`prompt`) — v2
// scrape takes a single `url` and embeds the schema in a `json` format object,
// returning the extracted object inline under `data.json` (no polling).
const scrapeJson = async <T>(url: string, schema: object, prompt: string): Promise<T | {}> => {
  const response = await fetch(`${FIRECRAWL_BASE}/v2/scrape`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      onlyMainContent: true,
      formats: [{ type: 'json', prompt, schema }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl scrape(json) → ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { success: boolean; data?: { json?: T } };
  return body.data?.json ?? {};
};

export const extractLabPage = async (url: string): Promise<LabPageExtract> =>
  scrapeJson<LabPageExtract>(
    url,
    labPageSchema,
    'Extract details about this robotics research lab. Focus on what equipment they use, what research areas they work on, who runs the lab, and any recent news or projects.',
  );

// Team-page primitive — distinct from extractLabPage. Lab pages give us
// metadata about the LAB; team pages give us a list of PEOPLE with titles
// and (if we're lucky) emails / LinkedIn URLs.
export type TeamMember = {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
};

export type TeamPageExtract = {
  members?: TeamMember[];
};

const teamPageSchema = {
  type: 'object',
  properties: {
    members: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fullName: { type: 'string', description: 'Full name as displayed on the page.' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          title: { type: 'string', description: 'Role / job title.' },
          email: { type: 'string', description: 'Email if listed (rare on commercial team pages).' },
          linkedinUrl: { type: 'string', description: 'LinkedIn URL if listed.' },
        },
      },
      description: 'List of team members / employees / staff.',
    },
  },
};

export const extractTeamPage = async (url: string): Promise<TeamPageExtract> =>
  scrapeJson<TeamPageExtract>(
    url,
    teamPageSchema,
    'Extract the list of team members / staff / employees shown on this page. For each: their full name, role/title, and email or LinkedIn URL if listed. Skip the company description or boilerplate.',
  );

export const scrapeMarkdown = async (url: string): Promise<string> => {
  const response = await fetch(`${FIRECRAWL_BASE}/v2/scrape`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl scrape → ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data?: { markdown?: string } };
  return body.data?.markdown ?? '';
};

export const labExtractToSummary = (extract: LabPageExtract): string => {
  const lines: string[] = [];
  if (extract.labName) lines.push(`Lab: ${extract.labName}`);
  if (extract.pi) lines.push(`PI: ${extract.pi}`);
  if (extract.focusAreas?.length) lines.push(`Focus: ${extract.focusAreas.join(', ')}`);
  if (extract.equipment?.length) lines.push(`Equipment: ${extract.equipment.join(', ')}`);
  if (extract.currentProjects?.length)
    lines.push(`Projects: ${extract.currentProjects.join('; ')}`);
  if (extract.fundingSources?.length) lines.push(`Funding: ${extract.fundingSources.join(', ')}`);
  if (extract.studentsCount) lines.push(`~${extract.studentsCount} students`);
  if (extract.recentNews?.length) lines.push(`News: ${extract.recentNews.join('; ')}`);
  return lines.join('\n');
};
