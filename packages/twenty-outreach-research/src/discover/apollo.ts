// Apollo.io API client. Used to expand a known company domain into named
// contacts (engineers, ML leads, researchers). Free-tier limits apply; the
// `people/search` endpoint returns 25/page.
const APOLLO_BASE = 'https://api.apollo.io/v1';

const apiKey = (): string => {
  const k = process.env.APOLLO_API_KEY;
  if (!k) throw new Error('APOLLO_API_KEY is not set');
  return k;
};

export type ApolloPerson = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  title?: string;
  linkedinUrl?: string;
  city?: string;
  organizationName?: string;
  organizationDomain?: string;
};

type RawApolloPerson = {
  id: string;
  first_name: string | null;
  // On the new api_search endpoint last_name is OBFUSCATED ("Mi***u") and the
  // real value lives behind /v1/people/match (1 credit per unlock). The full
  // last_name only comes back from match.
  last_name: string | null;
  last_name_obfuscated?: string | null;
  email: string | null;
  has_email?: boolean;
  title: string | null;
  linkedin_url: string | null;
  city: string | null;
  organization: { name: string | null; primary_domain: string | null } | null;
};

type ApolloSearchResponse = {
  people: RawApolloPerson[];
  pagination?: { page: number; per_page: number; total_entries: number };
};

const norm = (p: RawApolloPerson): ApolloPerson => ({
  id: p.id,
  firstName: p.first_name ?? '',
  // Keep the obfuscated value when last_name is missing; downstream code can
  // call enrichPersonById to unlock it. Display layers should treat empty
  // lastName as "needs enrichment".
  lastName: p.last_name ?? '',
  ...(p.email && { email: p.email }),
  ...(p.title && { title: p.title }),
  ...(p.linkedin_url && { linkedinUrl: p.linkedin_url }),
  ...(p.city && { city: p.city }),
  ...(p.organization?.name && { organizationName: p.organization.name }),
  ...(p.organization?.primary_domain && { organizationDomain: p.organization.primary_domain }),
});

export const searchPeopleAtCompany = async (
  organizationDomain: string,
  titleKeywords: string[],
  limit = 25,
): Promise<ApolloPerson[]> => {
  // Apollo deprecated /mixed_people/search for API callers 2026-Q1; use
  // /mixed_people/api_search. Response shape changed too: last_name + email
  // come back obfuscated. Call enrichPersonById on Apollo IDs you want to
  // unlock (1 credit each on the Basic plan; 2,500/mo budget).
  // Docs: https://docs.apollo.io/reference/people-api-search
  const response = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey(),
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      q_organization_domains_list: [organizationDomain],
      person_titles: titleKeywords,
      page: 1,
      per_page: Math.min(limit, 25),
    }),
  });
  if (!response.ok) {
    throw new Error(`Apollo people search → ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as ApolloSearchResponse;
  return (body.people ?? []).map(norm);
};

// Match an existing person by name + employer domain (no Apollo id needed).
// /people/match accepts name + domain directly; returns the enriched record
// including `title`. Costs 1 credit per call. Returns null if Apollo has no
// match. Used by the title-backfill pass to fill missing jobTitles on contacts
// already in the CRM.
export const matchPersonByName = async (
  firstName: string,
  lastName: string,
  organizationDomain: string,
): Promise<ApolloPerson | null> => {
  const response = await fetch(`${APOLLO_BASE}/people/match`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey(),
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      domain: organizationDomain,
      reveal_personal_emails: false,
    }),
  });
  if (!response.ok) {
    console.warn(
      `[apollo] match ${firstName} ${lastName} @ ${organizationDomain} → ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
    return null;
  }
  const body = (await response.json()) as { person?: RawApolloPerson };
  if (!body.person) return null;
  return norm(body.person);
};

// Unlock a single person's full record (real last_name + verified email).
// Costs 1 credit on Apollo Basic. Returns null on failure; caller decides
// how to handle missing data (typically fall through to Hunter).
//
// Apollo's /people/match sometimes 400s on `id` alone with "missing last_name"
// for ambiguous records — pass any other identifiers we have to help match.
export const enrichPersonById = async (
  apolloId: string,
  hints: { firstName?: string; organizationDomain?: string } = {},
): Promise<ApolloPerson | null> => {
  const response = await fetch(`${APOLLO_BASE}/people/match`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey(),
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      id: apolloId,
      ...(hints.firstName && { first_name: hints.firstName }),
      ...(hints.organizationDomain && { domain: hints.organizationDomain }),
      reveal_personal_emails: false,
    }),
  });
  if (!response.ok) {
    console.warn(`[apollo] enrich ${apolloId} → ${response.status} ${(await response.text()).slice(0, 200)}`);
    return null;
  }
  const body = (await response.json()) as { person?: RawApolloPerson };
  if (!body.person) return null;
  return norm(body.person);
};
