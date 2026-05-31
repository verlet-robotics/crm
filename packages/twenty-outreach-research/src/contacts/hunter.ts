// Hunter.io client. Three primitives for Stage 2 email enrichment:
//   1. findEmail(first, last, domain) — best-guess email + confidence + verification.
//   2. domainSearch(domain) — common pattern + up to ~25 known emails per domain.
//   3. applyPattern(pattern, first, last, domain) — last-resort pattern formatter
//      when both endpoints return nothing.
//
// Hunter is the L2 enrichment fallback for academia + small co's where Apollo
// has no email coverage (.edu domains especially).
const HUNTER_BASE = 'https://api.hunter.io/v2';

const apiKey = (): string => {
  const k = process.env.HUNTER_API_KEY;
  if (!k) throw new Error('HUNTER_API_KEY is not set');
  return k;
};

export type HunterFindResult = {
  email: string;
  score: number;
  firstName?: string;
  lastName?: string;
  position?: string;
  linkedinUrl?: string;
  verification?: 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown';
  // Number of source URLs Hunter has for this email. >0 means Hunter scraped
  // the email from at least one webpage (real evidence the person uses this
  // address); 0 means Hunter computed it from a pattern alone (a guess that
  // may correspond to a completely different person at the domain).
  sourceCount: number;
};

type RawHunterFinder = {
  data?: {
    email: string | null;
    score: number | null;
    first_name: string | null;
    last_name: string | null;
    position: string | null;
    linkedin_url: string | null;
    verification?: { status?: string | null } | null;
    sources?: { uri?: string }[] | null;
  };
};

export const findEmail = async (
  firstName: string,
  lastName: string,
  domain: string,
): Promise<HunterFindResult | null> => {
  const params = new URLSearchParams({
    domain,
    first_name: firstName,
    last_name: lastName,
    api_key: apiKey(),
  });
  const res = await fetch(`${HUNTER_BASE}/email-finder?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Hunter find → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as RawHunterFinder;
  if (!body.data?.email) return null;
  return {
    email: body.data.email,
    score: body.data.score ?? 0,
    sourceCount: body.data.sources?.length ?? 0,
    ...(body.data.first_name && { firstName: body.data.first_name }),
    ...(body.data.last_name && { lastName: body.data.last_name }),
    ...(body.data.position && { position: body.data.position }),
    ...(body.data.linkedin_url && { linkedinUrl: body.data.linkedin_url }),
    ...(body.data.verification?.status && {
      verification: body.data.verification.status as HunterFindResult['verification'],
    }),
  };
};

export type HunterDomainPerson = {
  email: string;
  firstName?: string;
  lastName?: string;
  position?: string;
  linkedinUrl?: string;
  confidence: number;
};

type RawHunterDomain = {
  data?: {
    pattern: string | null;
    emails?: {
      value: string;
      first_name: string | null;
      last_name: string | null;
      position: string | null;
      linkedin: string | null;
      confidence: number | null;
    }[];
  };
};

export const domainSearch = async (
  domain: string,
): Promise<{ pattern: string | null; people: HunterDomainPerson[] }> => {
  // Free tier caps results at 10 per request. Don't ask for more; 10 emails
  // is plenty for pattern detection + cross-referencing names to candidates.
  const params = new URLSearchParams({ domain, api_key: apiKey(), limit: '10' });
  const res = await fetch(`${HUNTER_BASE}/domain-search?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 404) return { pattern: null, people: [] };
    throw new Error(`Hunter domain → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as RawHunterDomain;
  const people = (body.data?.emails ?? []).map((e) => ({
    email: e.value,
    ...(e.first_name && { firstName: e.first_name }),
    ...(e.last_name && { lastName: e.last_name }),
    ...(e.position && { position: e.position }),
    ...(e.linkedin && { linkedinUrl: e.linkedin }),
    confidence: e.confidence ?? 0,
  }));
  return { pattern: body.data?.pattern ?? null, people };
};

// Verify a single email address via Hunter's dedicated verifier (the
// authoritative deliverability check — SMTP probe, MX, catch-all detection).
// Costs 1 verification credit. Returns the status + score (0–100); null on
// failure so callers fail-open rather than block a send on a transient error.
export type HunterVerifyResult = {
  status: 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown';
  score: number;
};

export const verifyEmail = async (email: string): Promise<HunterVerifyResult | null> => {
  const params = new URLSearchParams({ email, api_key: apiKey() });
  const res = await fetch(`${HUNTER_BASE}/email-verifier?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    console.warn(`[hunter] verify ${email} → ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { data?: { status?: string | null; score?: number | null } };
  if (!body.data?.status) return null;
  return {
    status: body.data.status as HunterVerifyResult['status'],
    score: body.data.score ?? 0,
  };
};

// Apply a Hunter pattern (e.g. "{first}.{last}") to a name + domain. Used as
// a final fallback when email-finder + domain-search both miss a contact.
export const applyPattern = (
  pattern: string,
  firstName: string,
  lastName: string,
  domain: string,
): string => {
  const first = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const last = lastName.toLowerCase().replace(/[^a-z]/g, '');
  const local = pattern
    .replace(/\{first\}/g, first)
    .replace(/\{last\}/g, last)
    .replace(/\{f\}/g, first[0] ?? '')
    .replace(/\{l\}/g, last[0] ?? '');
  return `${local}@${domain}`;
};
