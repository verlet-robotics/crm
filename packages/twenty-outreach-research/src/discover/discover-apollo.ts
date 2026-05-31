// L1 discovery — Apollo org-chart traversal.
//
// For each ICP_COMPANY (commercial humanoid/foundation-model targets), pull
// senior research/engineering titles via Apollo's mixed_people search, upsert
// the Company by domain, then upsert each Person with researchStatus=NEEDS_RESEARCH.
//
// Idempotent — duplicate runs skip existing People.
import 'dotenv/config';

import { upsertCompanyByDomain, upsertPersonFromDiscovery } from '../lib/twenty-client.js';

import { searchPeopleAtCompany } from './apollo.js';
import { ICP_COMPANIES } from './sources.js';

type Stats = { created: number; skipped: number; errors: number };

export const discoverFromApollo = async (
  opts: { dryRun?: boolean } = {},
): Promise<Stats> => {
  const stats: Stats = { created: 0, skipped: 0, errors: 0 };

  for (const target of ICP_COMPANIES) {
    console.log(`[discover:apollo] ${target.name} (${target.domain})`);
    let people: Awaited<ReturnType<typeof searchPeopleAtCompany>>;
    try {
      people = await searchPeopleAtCompany(target.domain, target.titleMatchers, 15);
    } catch (err) {
      console.warn(`[discover:apollo] failed for ${target.name}:`, err);
      stats.errors += 1;
      continue;
    }
    console.log(`  → ${people.length} candidates`);

    if (people.length === 0) continue;

    let companyId: string | undefined;
    if (!opts.dryRun) {
      const company = await upsertCompanyByDomain({
        name: target.name,
        domainName: target.domain,
        accountType: 'COMPANY',
        idealCustomerProfile: true,
      });
      companyId = company.id;
    }

    for (const person of people) {
      if (!person.firstName || !person.lastName) {
        stats.skipped += 1;
        continue;
      }

      if (opts.dryRun) {
        console.log(`  + ${person.firstName} ${person.lastName} — ${person.title ?? '?'}`);
        stats.created += 1;
        continue;
      }

      try {
        const result = await upsertPersonFromDiscovery({
          firstName: person.firstName,
          lastName: person.lastName,
          ...(person.email && { primaryEmail: person.email }),
          ...(person.title && { jobTitle: person.title }),
          ...(person.linkedinUrl && { linkedinUrl: person.linkedinUrl }),
          ...(person.city && { city: person.city }),
          ...(companyId && { companyId }),
          discoverySource: 'APOLLO',
          discoveryRef: person.id,
        });
        if (result.created) {
          stats.created += 1;
          console.log(
            `  + ${person.firstName} ${person.lastName} — ${person.title ?? '?'}`,
          );
        } else {
          stats.skipped += 1;
        }
      } catch (err) {
        console.warn(
          `[discover:apollo] upsert failed for ${person.firstName} ${person.lastName}:`,
          err,
        );
        stats.errors += 1;
      }
    }
  }
  return stats;
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await discoverFromApollo({ dryRun });
  console.log('[discover:apollo] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
