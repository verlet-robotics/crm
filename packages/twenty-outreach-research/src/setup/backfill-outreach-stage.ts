// One-time backfill: set Company.outreachStage for every GTM account
// (accountType ∈ COMPANY/LAB/INSTITUTION) by aggregating its People.researchStatus.
//
// Uses the same advance-only / manual-zone rules as the live pipeline
// (recomputeCompanyOutreachStage). Idempotent and safe to re-run — it never
// pulls a company back, and never touches a company already in PILOT/CLOSED_*.
//
// Run: doppler run --project crm --config dev_verlet -- npx tsx src/setup/backfill-outreach-stage.ts [--dry-run]
import {
  twentyGraphQL,
  computeOutreachStage,
  recomputeCompanyOutreachStage,
} from '../lib/twenty-client.js';

const DRY = process.argv.includes('--dry-run');

const main = async (): Promise<void> => {
  console.log(`Backfill Company.outreachStage — ${DRY ? 'DRY RUN' : 'LIVE'}\n`);

  const query = `
    query GtmCompanies {
      companies(first: 300) {
        edges {
          node {
            id
            name
            accountType
            outreachStage
            people { edges { node { researchStatus discoverySource } } }
          }
        }
      }
    }
  `;
  type Node = {
    id: string;
    name: string;
    accountType: string | null;
    outreachStage: string | null;
    people: { edges: { node: { researchStatus: string | null; discoverySource: string | null } }[] };
  };
  const data = await twentyGraphQL<{ companies: { edges: { node: Node }[] } }>(query);
  const gtm = data.companies.edges
    .map((e) => e.node)
    .filter((c) => ['COMPANY', 'LAB', 'INSTITUTION'].includes(c.accountType ?? ''));

  const tally: Record<string, number> = {};
  let changed = 0;

  for (const c of gtm) {
    const computed = computeOutreachStage(c.people.edges.map((e) => e.node));
    tally[computed] = (tally[computed] ?? 0) + 1;
    const willChange = c.outreachStage !== computed;
    console.log(
      `  ${willChange ? '→' : ' '} ${(c.outreachStage ?? '∅').padEnd(16)} ${computed.padEnd(16)} ${c.name} (${c.people.edges.length}p)`,
    );
    if (!DRY) {
      const written = await recomputeCompanyOutreachStage(c.id).catch((err) => {
        console.warn(`    ✗ ${c.name}: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (written) changed += 1;
      await new Promise((r) => setTimeout(r, 250)); // stay under the local rate limit
    }
  }

  console.log(`\nComputed distribution: ${JSON.stringify(tally)}`);
  console.log(`GTM companies: ${gtm.length} | ${DRY ? 'would write' : 'written'}: ${DRY ? gtm.filter((c) => c.outreachStage === null).length + '+' : changed}`);
};

main().catch((err) => {
  console.error('backfill-outreach-stage FAILED');
  console.error(err);
  process.exit(1);
});
