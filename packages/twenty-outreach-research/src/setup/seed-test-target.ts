// Seeds one known robotics PI so we can run the pipeline end-to-end without
// waiting for the Notion → Twenty migration. Idempotent.
//
// Usage: tsx src/setup/seed-test-target.ts
import 'dotenv/config';
import {
  upsertCompanyByDomain,
  upsertPersonByEmail,
  updatePersonFields,
} from '../lib/twenty-client.js';

const main = async () => {
  console.log('[seed] creating UT Austin company…');
  const company = await upsertCompanyByDomain({
    name: 'UT Austin · Texas Robotics',
    domainName: 'cs.utexas.edu',
    city: 'Austin, TX',
  });
  console.log(`[seed] company: ${company.id} (${company.name})`);

  console.log('[seed] creating Yuke Zhu Person…');
  const person = await upsertPersonByEmail({
    firstName: 'Yuke',
    lastName: 'Zhu',
    primaryEmail: 'yukez@cs.utexas.edu',
    jobTitle: 'Assistant Professor',
    city: 'Austin, TX',
    companyId: company.id,
  });
  console.log(`[seed] person: ${person.id}`);

  await updatePersonFields(person.id, { researchStatus: 'NEEDS_RESEARCH' });
  console.log('[seed] flipped researchStatus → NEEDS_RESEARCH');

  console.log('');
  console.log('=== READY ===');
  console.log(`Person ID: ${person.id}`);
  console.log('');
  console.log('Next:');
  console.log(`  yarn smoke:gather -- --target "Yuke Zhu" --affiliation "UT Austin" --lab https://rpl.cs.utexas.edu/ --twitter yukez`);
  console.log(`  yarn run:person -- --person-id ${person.id} --dry-run`);
  console.log(`  yarn run:person -- --person-id ${person.id}`);
};

main().catch((err) => {
  console.error('[seed] FAILED');
  console.error(err);
  process.exit(1);
});
