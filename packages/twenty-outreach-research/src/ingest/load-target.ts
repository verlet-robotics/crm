// Translate a Twenty Person record into a TargetSpec that gather-inputs can
// consume. Reads Company.accountType to pick the right role and to flag the
// commercial-vs-academic register.
import { fetchPersonForResearch, type PersonForResearch } from '../lib/twenty-client.js';
import type { TargetSpec } from '../research/gather-inputs.js';

export type LoadedTarget = {
  person: PersonForResearch;
  spec: TargetSpec;
};

const xHandleFromUrl = (url?: string | null): string | undefined => {
  if (!url) return undefined;
  const m = url.match(/(?:x\.com|twitter\.com)\/(?:@)?([A-Za-z0-9_]+)/);
  return m?.[1];
};

const roleForTarget = (
  accountType?: string | null,
  jobTitle?: string | null,
  companyName?: string | null,
): TargetSpec['role'] => {
  const title = jobTitle ?? '';
  // accountType in the live data is UPPERCASE (LAB / INSTITUTION / COMPANY).
  // Normalise so a real LAB/INSTITUTION isn't mis-routed into the commercial
  // register (which would research a PI as an exec/engineer).
  const at = accountType?.toUpperCase();
  const academic =
    at === 'INSTITUTION' ||
    at === 'LAB' ||
    (!accountType &&
      !!companyName &&
      /university|college|institute|lab\b|robotics|\bcs\b/i.test(companyName));

  // Unambiguous title signals first — these win regardless of account type.
  if (/professor|\bprof\b|faculty|assistant.*prof|lab director|principal investigator/i.test(title)) {
    return 'professor';
  }
  if (/\bph\.?d\b|doctoral|grad(uate)? student|\bpostdoc\b|post-doc|\bm\.?s\.?c?\b|masters|\bstudent\b/i.test(title)) {
    return 'phd';
  }
  if (/\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bvp\b|head of|director|founder|chief/i.test(title)) {
    return 'exec';
  }

  // Ambiguous "researcher / visiting / scholar / scientist" — resolve by
  // context. In an academic lab these are grad-student-register people
  // (e.g. "Visiting Researcher"); at a company they're engineers.
  if (/research(er|\s+scientist|\s+fellow|\s+engineer|\s+associate|\s+assistant)?|visiting|scholar|intern/i.test(title)) {
    return academic ? 'phd' : 'engineer';
  }

  // No usable title — fall back to account-type context.
  if (academic) return 'professor';
  return 'engineer';
};

export const loadTarget = async (personId: string): Promise<LoadedTarget> => {
  const person = await fetchPersonForResearch(personId);
  if (!person) throw new Error(`Person ${personId} not found`);

  const firstName = person.name?.firstName ?? '';
  const lastName = person.name?.lastName ?? '';
  const fullName = `${firstName} ${lastName}`.trim();
  if (!fullName) throw new Error(`Person ${personId} has no name`);

  const affiliation = person.company?.name ?? person.city ?? 'unknown';
  const role = roleForTarget(
    person.company?.accountType,
    person.jobTitle,
    person.company?.name,
  );
  // Treat as commercial only if the role suggests it AND the company isn't
  // an obvious academic affiliation.
  const isCommercial = role === 'engineer' || role === 'exec';
  const domain = person.company?.domainName?.primaryLinkUrl;
  // The Company's curated lab roster URL (set in Stage 2) is the real lab page
  // to scrape — far better signal than the person's LinkedIn. LinkedIn stays a
  // last-resort homepage hint only.
  const labUrl = person.company?.labPageUrl?.trim() || undefined;

  const spec: TargetSpec = {
    name: fullName,
    affiliation,
    role,
    ...(labUrl && { labUrl }),
    ...(person.linkedinLink?.primaryLinkUrl && {
      // Treat LinkedIn as a fallback homepage hint for the Firecrawl scraper.
      homepageUrl: person.linkedinLink.primaryLinkUrl,
    }),
    ...(xHandleFromUrl(person.xLink?.primaryLinkUrl) && {
      twitterHandle: xHandleFromUrl(person.xLink?.primaryLinkUrl),
    }),
    ...(isCommercial && person.company?.name && { companyName: person.company.name }),
    ...(isCommercial && domain && { companyDomain: domain }),
  };

  return { person, spec };
};
