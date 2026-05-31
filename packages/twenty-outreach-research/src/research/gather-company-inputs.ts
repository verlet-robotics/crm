// Company-level input gathering for run-for-company. Mirrors gather-inputs.ts
// but pulls ONLY org-level signals (news, funding/hiring/products, company site)
// — no papers / social, which are person-level. Returns a ResearchInputs shaped
// for the company so synthesizeBrief({subject:'company'}) can consume it directly.
import type { ResearchInputs } from './synthesize-brief.js';
import { searchNews } from './scrapers/exa.js';
import { extractLabPage, labExtractToSummary } from './scrapers/firecrawl.js';
import { fetchCompanySignals } from './scrapers/company.js';

export type CompanyTargetSpec = {
  name: string;
  domain?: string;
  // Page to scrape for an "about/product" summary; defaults to https://<domain>.
  siteUrl?: string;
};

const settled = async <T>(label: string, promise: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await promise;
  } catch (err) {
    console.warn(`[gather-company] ${label} failed: ${err instanceof Error ? err.message : err}`);
    return fallback;
  }
};

export const gatherCompanyInputs = async (spec: CompanyTargetSpec): Promise<ResearchInputs> => {
  console.log(`[gather-company] starting for ${spec.name}${spec.domain ? ' (' + spec.domain + ')' : ''}`);

  const siteUrl = spec.siteUrl ?? (spec.domain ? `https://${spec.domain}` : undefined);

  const [news, companySignals, sitePage] = await Promise.all([
    settled('news', searchNews(spec.name, 'robotics AI company', 365), []),
    settled(
      'companySignals',
      fetchCompanySignals(spec.name, spec.domain),
      null as Awaited<ReturnType<typeof fetchCompanySignals>> | null,
    ),
    siteUrl
      ? settled(
          'site',
          (async () => {
            const extract = await extractLabPage(siteUrl);
            return { url: siteUrl, extractedSummary: labExtractToSummary(extract) };
          })(),
          null as { url: string; extractedSummary: string } | null,
        )
      : Promise.resolve(null),
  ]);

  console.log(
    `[gather-company] news=${news.length} companySignals=${companySignals ? 'yes' : 'no'} site=${sitePage ? 'yes' : 'no'}`,
  );

  return {
    target: { name: spec.name, affiliation: spec.name, role: 'exec' },
    papers: [],
    news,
    social: [],
    ...(sitePage && { labPage: sitePage }),
    ...(companySignals && { companySignals }),
  };
};
