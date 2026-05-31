import 'dotenv/config';

const apiUrl = process.env.TWENTY_API_URL ?? 'http://localhost:3000';
const apiKey = process.env.TWENTY_API_KEY;

if (!apiKey) {
  throw new Error(
    'TWENTY_API_KEY is not set. Generate one in Twenty Settings → Developers → API keys.',
  );
}

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: unknown }[];
};

export const twentyGraphQL = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${apiUrl}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as GraphQLResponse<T>;

  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).join(' | ');
    throw new TwentyApiError(message, body.errors);
  }

  if (!body.data) {
    throw new TwentyApiError('GraphQL response had no data field', body);
  }

  return body.data;
};

export const twentyMetadataGraphQL = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${apiUrl}/metadata`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as GraphQLResponse<T>;

  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).join(' | ');
    throw new TwentyApiError(message, body.errors);
  }

  if (!body.data) {
    throw new TwentyApiError('Metadata GraphQL response had no data field', body);
  }

  return body.data;
};

export class TwentyApiError extends Error {
  constructor(
    message: string,
    public readonly detail: unknown,
  ) {
    super(message);
    this.name = 'TwentyApiError';
  }
}

export type PersonRecord = {
  id: string;
  name?: { firstName?: string; lastName?: string } | null;
  emails?: { primaryEmail?: string } | null;
  jobTitle?: string | null;
  city?: string | null;
  company?: { id: string; name?: string } | null;
};

export const listPeople = async (limit = 5): Promise<PersonRecord[]> => {
  const query = `
    query ListPeople($limit: Int) {
      people(first: $limit) {
        edges {
          node {
            id
            name { firstName lastName }
            emails { primaryEmail }
            jobTitle
            city
            company { id name }
          }
        }
      }
    }
  `;
  type Result = { people: { edges: { node: PersonRecord }[] } };
  const data = await twentyGraphQL<Result>(query, { limit });
  return data.people.edges.map((e) => e.node);
};

export type CompanyDiscoverySource =
  | 'MANUAL'
  | 'NOTION_IMPORT'
  | 'ARXIV'
  | 'EXA_SIMILAR'
  | 'APOLLO'
  | 'SEMANTIC_SCHOLAR'
  | 'GITHUB'
  | 'CITATIONS'
  | 'COAUTHOR'
  | 'ENRICHMENT'
  | 'INSTITUTION_SCAN'
  | 'FUNDING_NEWS';

export type CompanyUpsertInput = {
  name: string;
  domainName?: string;
  employees?: number;
  city?: string;
  idealCustomerProfile?: boolean;
  accountType?: 'COMPANY' | 'INSTITUTION' | 'LAB';
  pendingReview?: boolean;
  discoverySource?: CompanyDiscoverySource;
  discoveryRef?: string;
  signalSummary?: string;
};

// Strip "www.", subdomain, ports, paths down to the registrable apex.
// "cs.utexas.edu" → "utexas.edu". Heuristic; assumes standard 2-label TLD
// suffixes (.edu, .com, .ai, .ac.uk → handles 3-label .ac.uk separately).
const apexDomain = (raw: string): string => {
  const cleaned = raw
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .toLowerCase()
    .trim();
  const parts = cleaned.split('.');
  if (parts.length <= 2) return cleaned;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // Two-label TLDs: .ac.uk, .co.uk, .ac.jp, .co.jp.
  if (['uk', 'jp', 'nz', 'au'].includes(last) && ['ac', 'co'].includes(second)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
};

export const upsertCompanyByDomain = async (
  input: CompanyUpsertInput,
): Promise<{ id: string; name: string }> => {
  // Strategy: exact domain → apex domain (e.g. cs.utexas.edu → utexas.edu) →
  // exact name (case-insensitive). Any hit wins; if all miss we create.
  type FindResult = {
    companies: { edges: { node: { id: string; name: string } }[] };
  };

  if (input.domainName) {
    const exactQuery = `
      query FindCompanyByDomainExact($domain: String!) {
        companies(filter: { domainName: { primaryLinkUrl: { eq: $domain } } }, first: 1) {
          edges { node { id name } }
        }
      }
    `;
    const exact = await twentyGraphQL<FindResult>(exactQuery, {
      domain: input.domainName,
    });
    if (exact.companies.edges[0]?.node) return exact.companies.edges[0].node;

    const apex = apexDomain(input.domainName);
    if (apex && apex !== input.domainName) {
      const apexResult = await twentyGraphQL<FindResult>(exactQuery, { domain: apex });
      if (apexResult.companies.edges[0]?.node) return apexResult.companies.edges[0].node;
    }

    // Suffix match — catch existing rows that stored the subdomain (e.g.
    // cs.utexas.edu) when we now have the apex (utexas.edu) or vice versa.
    const suffixQuery = `
      query FindCompanyByDomainSuffix($suffix: String!) {
        companies(filter: { domainName: { primaryLinkUrl: { like: $suffix } } }, first: 5) {
          edges { node { id name } }
        }
      }
    `;
    const suffix = await twentyGraphQL<FindResult>(suffixQuery, {
      suffix: `%${apex}`,
    });
    const suffixHit = suffix.companies.edges[0]?.node;
    if (suffixHit) return suffixHit;
  }

  // Fallback: exact name match (rare but useful when domain wasn't recorded).
  const nameQuery = `
    query FindCompanyByName($name: String!) {
      companies(filter: { name: { ilike: $name } }, first: 1) {
        edges { node { id name } }
      }
    }
  `;
  const byName = await twentyGraphQL<FindResult>(nameQuery, { name: input.name });
  if (byName.companies.edges[0]?.node) return byName.companies.edges[0].node;

  // Company has no `city` field; the place lives on `address.addressCity`.
  const createMutation = `
    mutation CreateCompany($data: CompanyCreateInput!) {
      createCompany(data: $data) { id name }
    }
  `;
  type CreateResult = { createCompany: { id: string; name: string } };
  const created = await twentyGraphQL<CreateResult>(createMutation, {
    data: {
      name: input.name,
      ...(input.domainName && { domainName: { primaryLinkUrl: input.domainName } }),
      ...(input.employees != null && { employees: input.employees }),
      ...(input.city && { address: { addressCity: input.city } }),
      ...(input.idealCustomerProfile != null && {
        idealCustomerProfile: input.idealCustomerProfile,
      }),
      ...(input.accountType && { accountType: input.accountType }),
      ...(input.pendingReview != null && { pendingReview: input.pendingReview }),
      ...(input.discoverySource && { discoverySource: input.discoverySource }),
      ...(input.discoveryRef && { discoveryRef: input.discoveryRef }),
      ...(input.signalSummary && { signalSummary: input.signalSummary }),
    },
  });
  return created.createCompany;
};

// Stage 1 institution-discovery upsert. Sets pendingReview=true so Mateo
// can triage the row in Twenty. Idempotent — if the Company already exists
// (by domain or name) we DO NOT overwrite accountType, only refresh the
// signalSummary + discoveryRef so re-running adds context, not noise.
export const upsertCandidateCompany = async (input: {
  name: string;
  domainName?: string;
  discoverySource: CompanyDiscoverySource;
  discoveryRef: string;
  signalSummary: string;
}): Promise<{ id: string; name: string; created: boolean }> => {
  // First try to find an existing row by domain (or apex / suffix).
  if (input.domainName) {
    type FindResult = {
      companies: { edges: { node: { id: string; name: string } }[] };
    };
    const exactQuery = `
      query FindCompanyByDomainExact($domain: String!) {
        companies(filter: { domainName: { primaryLinkUrl: { eq: $domain } } }, first: 1) {
          edges { node { id name } }
        }
      }
    `;
    const exact = await twentyGraphQL<FindResult>(exactQuery, { domain: input.domainName });
    const hit = exact.companies.edges[0]?.node;
    if (hit) {
      // Don't clobber accountType on a refresh; only update signal context.
      const updateMutation = `
        mutation RefreshCandidate($id: UUID!, $data: CompanyUpdateInput!) {
          updateCompany(id: $id, data: $data) { id name }
        }
      `;
      await twentyGraphQL(updateMutation, {
        id: hit.id,
        data: {
          signalSummary: input.signalSummary,
          discoveryRef: input.discoveryRef,
        },
      });
      return { ...hit, created: false };
    }
  }
  const created = await upsertCompanyByDomain({
    name: input.name,
    ...(input.domainName && { domainName: input.domainName }),
    pendingReview: true,
    discoverySource: input.discoverySource,
    discoveryRef: input.discoveryRef,
    signalSummary: input.signalSummary,
  });
  return { ...created, created: true };
};

export type CompanyForLookup = {
  id: string;
  name: string;
  domainName: string;
  accountType?: 'COMPANY' | 'INSTITUTION' | 'LAB';
  // Stage 2 academic-finder inputs. Set on the Company in Twenty (or fall back
  // to CLI flags / INSTITUTION_ALLOWLIST defaults).
  labPageUrl?: string;
  principalInvestigator?: string;
};

export const fetchCompanyById = async (
  id: string,
): Promise<CompanyForLookup | null> => {
  const query = `
    query GetCompanyById($id: UUID!) {
      company(filter: { id: { eq: $id } }) {
        id
        name
        domainName { primaryLinkUrl }
        accountType
        labPageUrl
        principalInvestigator
      }
    }
  `;
  type Result = {
    company: {
      id: string;
      name: string;
      domainName: { primaryLinkUrl: string };
      accountType?: 'COMPANY' | 'INSTITUTION' | 'LAB';
      labPageUrl?: string | null;
      principalInvestigator?: string | null;
    } | null;
  };
  const data = await twentyGraphQL<Result>(query, { id });
  if (!data.company) return null;
  return {
    id: data.company.id,
    name: data.company.name,
    domainName: data.company.domainName?.primaryLinkUrl ?? '',
    ...(data.company.accountType && { accountType: data.company.accountType }),
    ...(data.company.labPageUrl && { labPageUrl: data.company.labPageUrl }),
    ...(data.company.principalInvestigator && {
      principalInvestigator: data.company.principalInvestigator,
    }),
  };
};

export const fetchCompanyByDomain = async (
  domain: string,
): Promise<CompanyForLookup | null> => {
  const query = `
    query GetCompanyByDomain($domain: String!) {
      companies(
        filter: { domainName: { primaryLinkUrl: { eq: $domain } } }
        first: 1
      ) {
        edges {
          node {
            id
            name
            domainName { primaryLinkUrl }
            accountType
            labPageUrl
            principalInvestigator
          }
        }
      }
    }
  `;
  type Result = {
    companies: {
      edges: {
        node: {
          id: string;
          name: string;
          domainName: { primaryLinkUrl: string };
          accountType?: 'COMPANY' | 'INSTITUTION' | 'LAB';
          labPageUrl?: string | null;
          principalInvestigator?: string | null;
        };
      }[];
    };
  };
  const data = await twentyGraphQL<Result>(query, { domain });
  const node = data.companies.edges[0]?.node;
  if (!node) return null;
  return {
    id: node.id,
    name: node.name,
    domainName: node.domainName?.primaryLinkUrl ?? domain,
    ...(node.accountType && { accountType: node.accountType }),
    ...(node.labPageUrl && { labPageUrl: node.labPageUrl }),
    ...(node.principalInvestigator && { principalInvestigator: node.principalInvestigator }),
  };
};

export type PersonUpsertInput = {
  firstName: string;
  lastName: string;
  primaryEmail?: string;
  jobTitle?: string;
  city?: string;
  companyId?: string;
};

export const upsertPersonByEmail = async (
  input: PersonUpsertInput,
): Promise<{ id: string }> => {
  if (input.primaryEmail) {
    const findQuery = `
      query FindPersonByEmail($email: String!) {
        people(filter: { emails: { primaryEmail: { eq: $email } } }, first: 1) {
          edges { node { id } }
        }
      }
    `;
    type FindResult = { people: { edges: { node: { id: string } }[] } };
    const found = await twentyGraphQL<FindResult>(findQuery, { email: input.primaryEmail });
    const existing = found.people.edges[0]?.node;
    if (existing) return existing;
  }

  const createMutation = `
    mutation CreatePerson($data: PersonCreateInput!) {
      createPerson(data: $data) { id }
    }
  `;
  type CreateResult = { createPerson: { id: string } };
  const created = await twentyGraphQL<CreateResult>(createMutation, {
    data: {
      name: { firstName: input.firstName, lastName: input.lastName },
      ...(input.primaryEmail && { emails: { primaryEmail: input.primaryEmail } }),
      ...(input.jobTitle && { jobTitle: input.jobTitle }),
      ...(input.city && { city: input.city }),
      ...(input.companyId && { companyId: input.companyId }),
    },
  });
  return created.createPerson;
};

export const updatePersonFields = async (
  personId: string,
  fields: Record<string, unknown>,
): Promise<void> => {
  const mutation = `
    mutation UpdatePerson($id: UUID!, $data: PersonUpdateInput!) {
      updatePerson(id: $id, data: $data) { id }
    }
  `;
  await twentyGraphQL(mutation, { id: personId, data: fields });
};

// Institutional addresses we never want to lose in favour of a personal one.
const INSTITUTIONAL_EMAIL = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/i;

// Merge a newly-discovered email into a person's existing email set WITHOUT
// clobbering. An institutional (.edu / .ac.xx) address always wins primary;
// everything else is kept as an additional email. Returns the emails composite
// to write, or null when nothing would change (so callers can skip the write).
export const mergeEmails = (
  current: { primaryEmail?: string | null; additionalEmails?: string[] | null } | null | undefined,
  candidate?: string,
): { primaryEmail: string; additionalEmails: string[] } | null => {
  const curPrimary = current?.primaryEmail?.trim() ?? '';
  const curAdditional = (current?.additionalEmails ?? []).map((e) => e.trim()).filter(Boolean);
  const cand = candidate?.trim() ?? '';

  const all: string[] = [];
  const seen = new Set<string>();
  for (const e of [curPrimary, ...curAdditional, cand]) {
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(e);
  }
  if (all.length === 0) return null;

  const institutional = all.find((e) => INSTITUTIONAL_EMAIL.test(e));
  const primary = institutional ?? (curPrimary || all[0]);
  const additional = all.filter((e) => e.toLowerCase() !== primary.toLowerCase());

  const sameAdditional =
    additional.length === curAdditional.length &&
    additional.every((e) => curAdditional.some((c) => c.toLowerCase() === e.toLowerCase()));
  if (primary.toLowerCase() === curPrimary.toLowerCase() && sameAdditional) return null;

  return { primaryEmail: primary, additionalEmails: additional };
};

// Reconcile a person's emails so an institutional (.edu/.ac) address is always
// primary and nothing is ever dropped. Pass a candidate to add a newly
// discovered address; pass none to just re-prioritise the existing set.
// No-op when nothing would change.
export const reconcilePersonEmail = async (
  personId: string,
  candidateEmail?: string,
): Promise<void> => {
  const query = `
    query PersonEmails($id: UUID!) {
      person(filter: { id: { eq: $id } }) {
        emails { primaryEmail additionalEmails }
      }
    }
  `;
  type Result = {
    person: { emails?: { primaryEmail?: string; additionalEmails?: string[] } | null } | null;
  };
  const data = await twentyGraphQL<Result>(query, { id: personId });
  const merged = mergeEmails(data.person?.emails, candidateEmail);
  if (!merged) return;
  await updatePersonFields(personId, { emails: merged });
};

export type PersonForResearch = {
  id: string;
  name?: { firstName?: string; lastName?: string } | null;
  emails?: { primaryEmail?: string; additionalEmails?: string[] } | null;
  jobTitle?: string | null;
  city?: string | null;
  linkedinLink?: { primaryLinkUrl?: string } | null;
  xLink?: { primaryLinkUrl?: string } | null;
  researchStatus?: string | null;
  company?: {
    id: string;
    name?: string;
    domainName?: { primaryLinkUrl?: string } | null;
    accountType?: string | null;
    labPageUrl?: string | null;
    principalInvestigator?: string | null;
  } | null;
};

export const fetchPersonForResearch = async (
  personId: string,
): Promise<PersonForResearch> => {
  const query = `
    query PersonForResearch($id: UUID!) {
      person(filter: { id: { eq: $id } }) {
        id
        name { firstName lastName }
        emails { primaryEmail additionalEmails }
        jobTitle
        city
        linkedinLink { primaryLinkUrl }
        xLink { primaryLinkUrl }
        researchStatus
        company {
          id
          name
          domainName { primaryLinkUrl }
          accountType
          labPageUrl
          principalInvestigator
        }
      }
    }
  `;
  type Result = { person: PersonForResearch };
  const data = await twentyGraphQL<Result>(query, { id: personId });
  return data.person;
};

export const findPeopleByResearchStatus = async (
  status: string,
  limit = 20,
): Promise<PersonForResearch[]> => {
  const query = `
    query PeopleByStatus($status: String!, $limit: Int) {
      people(
        filter: { researchStatus: { eq: $status } }
        first: $limit
      ) {
        edges {
          node {
            id
            name { firstName lastName }
            emails { primaryEmail }
            jobTitle
            researchStatus
            company {
              id
              name
              domainName { primaryLinkUrl }
              accountType
            }
          }
        }
      }
    }
  `;
  type Result = { people: { edges: { node: PersonForResearch }[] } };
  const data = await twentyGraphQL<Result>(query, { status, limit });
  return data.people.edges.map((e) => e.node);
};

// ── Fit qualification ──────────────────────────────────────────────────────
// Minimal Person shape the fit classifier needs. accountType drives the
// academic-vs-company register (academic-lenient / company-strict bar).
export type PersonForQualification = {
  id: string;
  name?: { firstName?: string; lastName?: string } | null;
  jobTitle?: string | null;
  researchStatus?: string | null;
  linkedinLink?: { primaryLinkUrl?: string } | null;
  company?: {
    id: string;
    name?: string;
    accountType?: string | null;
    domainName?: { primaryLinkUrl?: string } | null;
  } | null;
};

// Fetch EVERY Person (cursor-paginated) with the fields the fit classifier
// needs. Used by the qualification pass to clean poor-fit contacts out of the
// CRM before any paid research runs.
export const listAllPeopleForQualification = async (
  pageSize = 60,
): Promise<PersonForQualification[]> => {
  const query = `
    query AllPeopleForQualification($first: Int!, $after: String) {
      people(first: $first, after: $after) {
        edges {
          node {
            id
            name { firstName lastName }
            jobTitle
            researchStatus
            linkedinLink { primaryLinkUrl }
            company { id name accountType domainName { primaryLinkUrl } }
          }
          cursor
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  type Result = {
    people: {
      edges: { node: PersonForQualification; cursor: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };

  const all: PersonForQualification[] = [];
  let after: string | null = null;
  // Hard cap on pages so a pathological response can't loop forever.
  for (let page = 0; page < 1000; page++) {
    const data: Result = await twentyGraphQL<Result>(query, {
      first: pageSize,
      after,
    });
    all.push(...data.people.edges.map((e) => e.node));
    if (!data.people.pageInfo.hasNextPage) break;
    after = data.people.pageInfo.endCursor;
    if (!after) break;
  }
  return all;
};

// Soft-delete a Person. Twenty's `deletePerson` sets deletedAt — the row drops
// out of every view but is recoverable from the deleted-records view.
// (`destroyPerson` is the permanent variant; we deliberately don't use it.)
export const deletePerson = async (id: string): Promise<void> => {
  const mutation = `
    mutation DeletePerson($id: UUID!) {
      deletePerson(id: $id) { id }
    }
  `;
  await twentyGraphQL(mutation, { id });
};

export const updateCompanyResearchSummary = async (
  companyId: string,
  markdown: string,
): Promise<void> => {
  const mutation = `
    mutation UpdateCompany($id: UUID!, $data: CompanyUpdateInput!) {
      updateCompany(id: $id, data: $data) { id }
    }
  `;
  await twentyGraphQL(mutation, {
    id: companyId,
    data: { researchSummary: { markdown } },
  });
};

// Generic Company field update (e.g. labPageUrl, principalInvestigator).
export const updateCompanyFields = async (
  companyId: string,
  fields: Record<string, unknown>,
): Promise<void> => {
  const mutation = `
    mutation UpdateCompany($id: UUID!, $data: CompanyUpdateInput!) {
      updateCompany(id: $id, data: $data) { id }
    }
  `;
  await twentyGraphQL(mutation, { id: companyId, data: fields });
};

// ── Company-level outreach pipeline stage (drives the Company Kanban) ──────────
// Auto-zone (IDENTIFIED..IN_CONVERSATION) is derived from this company's People
// researchStatus. Manual-zone (PILOT, CLOSED_WON, CLOSED_LOST) is set by hand in
// the UI and is NEVER overridden by the pipeline. Movement is advance-only.
export const COMPANY_OUTREACH_STAGES = [
  'IDENTIFIED',
  'CANDIDATES_FOUND',
  'RESEARCHING',
  'OUTREACH_SENT',
  'IN_CONVERSATION',
  'PILOT',
  'CLOSED_WON',
  'CLOSED_LOST',
] as const;
export type CompanyOutreachStage = (typeof COMPANY_OUTREACH_STAGES)[number];
const OUTREACH_STAGE_POSITION: Record<CompanyOutreachStage, number> =
  Object.fromEntries(COMPANY_OUTREACH_STAGES.map((s, i) => [s, i])) as Record<
    CompanyOutreachStage,
    number
  >;
const MANUAL_OUTREACH_STAGES: ReadonlySet<string> = new Set([
  'PILOT',
  'CLOSED_WON',
  'CLOSED_LOST',
]);
const RESEARCH_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'RESEARCHING',
  'RESEARCH_DONE',
  'DRAFTING',
  'DRAFTED',
  'NEEDS_REDRAFT',
  'APPROVED',
]);

// Pure: derive the auto-zone stage from a company's people.
export const computeOutreachStage = (
  people: { researchStatus?: string | null; discoverySource?: string | null }[],
): CompanyOutreachStage => {
  if (people.length === 0) return 'IDENTIFIED';
  const statuses = people.map((p) => p.researchStatus ?? '');
  if (statuses.includes('REPLIED')) return 'IN_CONVERSATION';
  if (statuses.includes('SENT')) return 'OUTREACH_SENT';
  if (statuses.some((s) => RESEARCH_ACTIVE_STATUSES.has(s))) return 'RESEARCHING';
  // No research activity yet — distinguish a discovered roster from a bare migrated record.
  const hasEnrichment = people.some((p) => p.discoverySource === 'ENRICHMENT');
  return hasEnrichment ? 'CANDIDATES_FOUND' : 'IDENTIFIED';
};

// Recompute and (advance-only) update a company's outreachStage. No-op if the
// company sits in the manual zone, or if the computed stage isn't further along.
// Returns the stage that was written, or null if nothing changed.
export const recomputeCompanyOutreachStage = async (
  companyId: string,
): Promise<CompanyOutreachStage | null> => {
  const query = `
    query CompanyOutreach($id: UUID!) {
      company(filter: { id: { eq: $id } }) {
        outreachStage
        people { edges { node { researchStatus discoverySource } } }
      }
    }
  `;
  type Result = {
    company: {
      outreachStage: string | null;
      people: { edges: { node: { researchStatus: string | null; discoverySource: string | null } }[] };
    } | null;
  };
  const data = await twentyGraphQL<Result>(query, { id: companyId });
  const company = data.company;
  if (!company) return null;

  const current = company.outreachStage;
  if (current && MANUAL_OUTREACH_STAGES.has(current)) return null;

  const computed = computeOutreachStage(company.people.edges.map((e) => e.node));
  const currentPos = current ? (OUTREACH_STAGE_POSITION[current as CompanyOutreachStage] ?? -1) : -1;
  if (OUTREACH_STAGE_POSITION[computed] <= currentPos) return null;

  await updateCompanyFields(companyId, { outreachStage: computed });
  return computed;
};

// Resolve a Person's company, then recompute that company's outreachStage.
// Used by the reply watcher, whose person records don't carry companyId.
export const recomputeOutreachStageForPerson = async (
  personId: string,
): Promise<CompanyOutreachStage | null> => {
  const query = `
    query PersonCompany($id: UUID!) {
      person(filter: { id: { eq: $id } }) { companyId }
    }
  `;
  type Result = { person: { companyId: string | null } | null };
  const data = await twentyGraphQL<Result>(query, { id: personId });
  const companyId = data.person?.companyId;
  if (!companyId) return null;
  return recomputeCompanyOutreachStage(companyId);
};

// Look up a Person by full name (no email). Used by discovery when we have a
// paper author name but no contact info yet — we don't want to create
// duplicate Person rows for people the team already has in CRM.
export const findPersonByName = async (
  firstName: string,
  lastName: string,
): Promise<{ id: string } | null> => {
  const query = `
    query FindPersonByName($first: String!, $last: String!) {
      people(
        filter: {
          and: [
            { name: { firstName: { eq: $first } } }
            { name: { lastName: { eq: $last } } }
          ]
        }
        first: 1
      ) {
        edges { node { id } }
      }
    }
  `;
  type Result = { people: { edges: { node: { id: string } }[] } };
  const data = await twentyGraphQL<Result>(query, { first: firstName, last: lastName });
  return data.people.edges[0]?.node ?? null;
};

// Discovery upsert — split name on whitespace, normalize, idempotent on (name)
// or (email if provided). Also writes the provenance fields (discoverySource,
// discoveryRef) on creation.
export const upsertPersonFromDiscovery = async (input: {
  firstName: string;
  lastName: string;
  primaryEmail?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  city?: string;
  companyId?: string;
  discoverySource: CompanyDiscoverySource;
  discoveryRef?: string;
}): Promise<{ id: string; created: boolean }> => {
  // Prefer email match first; fall back to name match.
  let existing: { id: string } | null = null;
  if (input.primaryEmail) {
    const findByEmail = `
      query FindByEmail($email: String!) {
        people(filter: { emails: { primaryEmail: { eq: $email } } }, first: 1) {
          edges { node { id } }
        }
      }
    `;
    type Result = { people: { edges: { node: { id: string } }[] } };
    const data = await twentyGraphQL<Result>(findByEmail, { email: input.primaryEmail });
    existing = data.people.edges[0]?.node ?? null;
  }
  if (!existing) {
    existing = await findPersonByName(input.firstName, input.lastName);
  }
  if (existing) {
    // Matched an existing record — don't clobber, but never drop a freshly
    // discovered institutional email. Keep both (institutional wins primary).
    if (input.primaryEmail) {
      await reconcilePersonEmail(existing.id, input.primaryEmail).catch((err) => {
        console.warn(
          `[discovery] email reconcile failed for ${existing!.id}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
    return { id: existing.id, created: false };
  }

  const createMutation = `
    mutation CreatePerson($data: PersonCreateInput!) {
      createPerson(data: $data) { id }
    }
  `;
  type CreateResult = { createPerson: { id: string } };
  const created = await twentyGraphQL<CreateResult>(createMutation, {
    data: {
      name: { firstName: input.firstName, lastName: input.lastName },
      ...(input.primaryEmail && { emails: { primaryEmail: input.primaryEmail } }),
      ...(input.jobTitle && { jobTitle: input.jobTitle }),
      ...(input.city && { city: input.city }),
      ...(input.companyId && { companyId: input.companyId }),
      ...(input.linkedinUrl && {
        linkedinLink: { primaryLinkUrl: input.linkedinUrl },
      }),
      researchStatus: 'NEEDS_RESEARCH',
      discoverySource: input.discoverySource,
      ...(input.discoveryRef && { discoveryRef: input.discoveryRef }),
    },
  });
  return { id: created.createPerson.id, created: true };
};

// People that have a Gmail thread but haven't yet been confirmed-sent.
// Used by the reply watcher to detect outbound = thread now contains a
// non-draft message.
export type PersonAwaitingSend = {
  id: string;
  gmailThreadId?: string | null;
  gmailMessageId?: string | null;
  researchStatus?: string | null;
};

export const findPeopleAwaitingSendConfirmation = async (
  limit = 50,
): Promise<PersonAwaitingSend[]> => {
  const query = `
    query AwaitingSend($limit: Int) {
      people(
        filter: {
          and: [
            { researchStatus: { eq: "APPROVED" } }
            { gmailThreadId: { neq: null } }
          ]
        }
        first: $limit
      ) {
        edges {
          node { id gmailThreadId gmailMessageId researchStatus }
        }
      }
    }
  `;
  type Result = { people: { edges: { node: PersonAwaitingSend }[] } };
  const data = await twentyGraphQL<Result>(query, { limit });
  return data.people.edges.map((e) => e.node);
};

// Look up a Person's gmailThreadId field — used by reply watcher to invert
// from "thread we've heard about" → "person we already drafted".
export const findPersonByGmailThreadId = async (
  threadId: string,
): Promise<{ id: string; researchStatus?: string | null } | null> => {
  const query = `
    query FindByThread($threadId: String!) {
      people(filter: { gmailThreadId: { eq: $threadId } }, first: 1) {
        edges { node { id researchStatus } }
      }
    }
  `;
  type Result = {
    people: { edges: { node: { id: string; researchStatus?: string | null } }[] };
  };
  const data = await twentyGraphQL<Result>(query, { threadId });
  return data.people.edges[0]?.node ?? null;
};

// Fetch the email body and other Gmail-ready fields once a Person hits APPROVED
// status. Returns null if a required field is missing — callers should log and
// skip those rows rather than throw.
export type PersonForGmail = {
  id: string;
  name?: { firstName?: string; lastName?: string } | null;
  emails?: { primaryEmail?: string } | null;
  emailDraftFinal?: { markdown?: string } | { blocknote?: string } | null;
  emailDraftV1?: { markdown?: string } | null;
  emailDraftV2?: { markdown?: string } | null;
  gmailDraftId?: string | null;
  gmailThreadId?: string | null;
  hookSummary?: string | null;
  emailConfidence?: string | null;
};

export const fetchPersonForGmail = async (personId: string): Promise<PersonForGmail> => {
  const query = `
    query PersonForGmail($id: UUID!) {
      person(filter: { id: { eq: $id } }) {
        id
        name { firstName lastName }
        emails { primaryEmail }
        emailDraftFinal { markdown }
        emailDraftV1 { markdown }
        emailDraftV2 { markdown }
        gmailDraftId
        gmailThreadId
        hookSummary
        emailConfidence
      }
    }
  `;
  type Result = { person: PersonForGmail };
  const data = await twentyGraphQL<Result>(query, { id: personId });
  return data.person;
};

// Create a Twenty Task on a Person — used by the reply watcher to flag replies
// that need human follow-up.
// Standalone Task — no Person/Company target. Used by Stage 1 to surface
// "Review N candidate institutions" in Mateo's task list. Tasks without
// assignees show up in the default "All Tasks" view in Twenty.
export const createTaskForUser = async (input: {
  title: string;
  bodyMarkdown: string;
  dueAt?: string;
}): Promise<{ id: string }> => {
  const createTask = `
    mutation CreateStandaloneTask($data: TaskCreateInput!) {
      createTask(data: $data) { id }
    }
  `;
  type CreateResult = { createTask: { id: string } };
  const task = await twentyGraphQL<CreateResult>(createTask, {
    data: {
      title: input.title,
      bodyV2: { markdown: input.bodyMarkdown },
      status: 'TODO',
      ...(input.dueAt && { dueAt: input.dueAt }),
    },
  });
  return task.createTask;
};

export const createTaskForPerson = async (input: {
  personId: string;
  title: string;
  bodyMarkdown: string;
  dueAt?: string;
}): Promise<{ id: string }> => {
  const createTask = `
    mutation CreateTask($data: TaskCreateInput!) {
      createTask(data: $data) { id }
    }
  `;
  type CreateResult = { createTask: { id: string } };
  const task = await twentyGraphQL<CreateResult>(createTask, {
    data: {
      title: input.title,
      bodyV2: { markdown: input.bodyMarkdown },
      status: 'TODO',
      ...(input.dueAt && { dueAt: input.dueAt }),
    },
  });

  const linkTask = `
    mutation LinkTaskToPerson($data: TaskTargetCreateInput!) {
      createTaskTarget(data: $data) { id }
    }
  `;
  await twentyGraphQL(linkTask, {
    data: { taskId: task.createTask.id, targetPersonId: input.personId },
  });
  return task.createTask;
};

export const attachNoteToPerson = async (
  personId: string,
  title: string,
  bodyMarkdown: string,
): Promise<{ id: string }> => {
  const createNote = `
    mutation CreateNote($data: NoteCreateInput!) {
      createNote(data: $data) { id }
    }
  `;
  type CreateResult = { createNote: { id: string } };
  const note = await twentyGraphQL<CreateResult>(createNote, {
    data: { title, bodyV2: { markdown: bodyMarkdown } },
  });

  const linkNote = `
    mutation LinkNoteToPerson($data: NoteTargetCreateInput!) {
      createNoteTarget(data: $data) { id }
    }
  `;
  // NoteTarget is polymorphic — Person link uses targetPersonId, not personId.
  await twentyGraphQL(linkNote, {
    data: { noteId: note.createNote.id, targetPersonId: personId },
  });
  return note.createNote;
};

// Attach a Note to a Company. NoteTarget morph field for companies is
// targetCompanyId (mirrors attachNoteToPerson). Used by run-for-company to pin
// the company brief + selling angles to the account.
export const attachNoteToCompany = async (
  companyId: string,
  title: string,
  bodyMarkdown: string,
): Promise<{ id: string }> => {
  const createNote = `
    mutation CreateNote($data: NoteCreateInput!) {
      createNote(data: $data) { id }
    }
  `;
  type CreateResult = { createNote: { id: string } };
  const note = await twentyGraphQL<CreateResult>(createNote, {
    data: { title, bodyV2: { markdown: bodyMarkdown } },
  });

  const linkNote = `
    mutation LinkNoteToCompany($data: NoteTargetCreateInput!) {
      createNoteTarget(data: $data) { id }
    }
  `;
  await twentyGraphQL(linkNote, {
    data: { noteId: note.createNote.id, targetCompanyId: companyId },
  });
  return note.createNote;
};

export type CompanyWithPeople = {
  id: string;
  name?: string | null;
  domainName?: { primaryLinkUrl?: string } | null;
  accountType?: string | null;
  labPageUrl?: string | null;
  principalInvestigator?: string | null;
  people: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    jobTitle?: string | null;
    email?: string | null;
    researchStatus?: string | null;
  }[];
};

// Fetch a Company plus its roster, flattened for run-for-company (company-level
// research + recommended-contact selection).
export const fetchCompanyWithPeople = async (
  companyId: string,
): Promise<CompanyWithPeople> => {
  const query = `
    query CompanyWithPeople($id: UUID!) {
      company(filter: { id: { eq: $id } }) {
        id
        name
        accountType
        labPageUrl
        principalInvestigator
        domainName { primaryLinkUrl }
        people {
          edges {
            node {
              id
              name { firstName lastName }
              jobTitle
              emails { primaryEmail }
              researchStatus
            }
          }
        }
      }
    }
  `;
  type Node = {
    id: string;
    name?: { firstName?: string; lastName?: string } | null;
    jobTitle?: string | null;
    emails?: { primaryEmail?: string } | null;
    researchStatus?: string | null;
  };
  type Result = {
    company: {
      id: string;
      name?: string | null;
      accountType?: string | null;
      labPageUrl?: string | null;
      principalInvestigator?: string | null;
      domainName?: { primaryLinkUrl?: string } | null;
      people: { edges: { node: Node }[] };
    } | null;
  };
  const data = await twentyGraphQL<Result>(query, { id: companyId });
  if (!data.company) throw new Error(`Company ${companyId} not found`);
  const c = data.company;
  return {
    id: c.id,
    name: c.name,
    accountType: c.accountType,
    labPageUrl: c.labPageUrl,
    principalInvestigator: c.principalInvestigator,
    domainName: c.domainName,
    people: c.people.edges.map((e) => ({
      id: e.node.id,
      firstName: e.node.name?.firstName ?? null,
      lastName: e.node.name?.lastName ?? null,
      jobTitle: e.node.jobTitle ?? null,
      email: e.node.emails?.primaryEmail ?? null,
      researchStatus: e.node.researchStatus ?? null,
    })),
  };
};
