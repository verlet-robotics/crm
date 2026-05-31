// Parallel orchestrator: given a target spec, fan out the 5 scrapers and
// return ResearchInputs ready for the L2 synthesizer. Each scraper runs
// concurrently and a failure in one does not block the others — the synth
// is tolerant of empty arrays.
import type { ResearchInputs } from './synthesize-brief.js';
import { fetchPapersForTarget } from './scrapers/papers.js';
import { searchNews, searchSocial } from './scrapers/exa.js';
import { extractLabPage, labExtractToSummary } from './scrapers/firecrawl.js';
import { fetchCompanySignals } from './scrapers/company.js';

export type TargetSpec = {
  name: string;
  affiliation: string;
  role: 'professor' | 'phd' | 'engineer' | 'exec';
  homepageUrl?: string;
  labUrl?: string;
  twitterHandle?: string;
  companyName?: string;
  companyDomain?: string;
};

const settled = async <T>(
  label: string,
  promise: Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await promise;
  } catch (err) {
    console.warn(`[gather] ${label} failed: ${err instanceof Error ? err.message : err}`);
    return fallback;
  }
};

export const gatherInputs = async (target: TargetSpec): Promise<ResearchInputs> => {
  console.log(`[gather] starting for ${target.name} @ ${target.affiliation}`);

  const tasks = await Promise.all([
    settled(
      'papers',
      fetchPapersForTarget(target.name, target.affiliation, 5),
      [] as Awaited<ReturnType<typeof fetchPapersForTarget>>,
    ),
    settled('news', searchNews(target.name, target.affiliation, 365), []),
    settled('social', searchSocial(target.name, target.twitterHandle), []),
    target.labUrl || target.homepageUrl
      ? settled(
          'labPage',
          (async () => {
            const url = target.labUrl ?? target.homepageUrl!;
            const extract = await extractLabPage(url);
            return { url, extractedSummary: labExtractToSummary(extract) };
          })(),
          null as { url: string; extractedSummary: string } | null,
        )
      : Promise.resolve(null),
    target.companyName
      ? settled(
          'company',
          fetchCompanySignals(target.companyName, target.companyDomain),
          null as Awaited<ReturnType<typeof fetchCompanySignals>> | null,
        )
      : Promise.resolve(null),
  ]);

  const [papers, news, social, labPage, companySignals] = tasks;

  console.log(
    `[gather] papers=${papers.length} news=${news.length} social=${social.length}` +
      ` labPage=${labPage ? 'yes' : 'no'} companySignals=${companySignals ? 'yes' : 'no'}`,
  );

  return {
    target: {
      name: target.name,
      affiliation: target.affiliation,
      role: target.role,
      ...(target.homepageUrl && { homepageUrl: target.homepageUrl }),
      ...(target.twitterHandle && { twitterHandle: target.twitterHandle }),
    },
    papers,
    news,
    social,
    ...(labPage && { labPage }),
    ...(companySignals && { companySignals }),
  };
};
