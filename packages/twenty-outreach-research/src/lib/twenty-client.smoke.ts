// Smoke test: prove we can talk to the Twenty CRM API.
// Run with: yarn nx run twenty-outreach-research:smoke:client
import { listPeople } from './twenty-client.js';

const main = async () => {
  console.log('[smoke] Fetching first 5 People from Twenty…');
  const people = await listPeople(5);
  console.log(`[smoke] Got ${people.length} people:`);
  for (const p of people) {
    const name = `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim() || '(no name)';
    const email = p.emails?.primaryEmail ?? '(no email)';
    const company = p.company?.name ?? '(no company)';
    console.log(`  • ${name}  <${email}>  @ ${company}`);
  }
  console.log('[smoke] Done.');
};

main().catch((err) => {
  console.error('[smoke] FAILED');
  console.error(err);
  process.exit(1);
});
