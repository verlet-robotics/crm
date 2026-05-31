// Quick CLI to dump everything the pipeline wrote for a Person — useful as a
// post-run sanity check until you're comfortable reading it in the Twenty UI.
//
// Usage: tsx src/lib/inspect-person.ts <person-id>
import 'dotenv/config';
import { twentyGraphQL } from './twenty-client.js';

const main = async () => {
  const personId = process.argv[2];
  if (!personId) {
    console.error('Usage: tsx src/lib/inspect-person.ts <person-id>');
    process.exit(2);
  }

  const query = `
    query Inspect($id: UUID!) {
      person(filter: { id: { eq: $id } }) {
        id
        name { firstName lastName }
        emails { primaryEmail }
        jobTitle
        researchStatus
        hookSummary
        emailDraftFinal { markdown }
        gmailDraftId
        company {
          id
          name
          researchSummary { markdown }
        }
        noteTargets {
          edges {
            node {
              note { title createdAt bodyV2 { markdown } }
            }
          }
        }
      }
    }
  `;

  type R = {
    person: {
      id: string;
      name?: { firstName?: string; lastName?: string };
      emails?: { primaryEmail?: string };
      jobTitle?: string | null;
      researchStatus?: string | null;
      hookSummary?: string | null;
      emailDraftFinal?: { markdown?: string } | null;
      gmailDraftId?: string | null;
      company?: { id: string; name?: string; researchSummary?: { markdown?: string } | null };
      noteTargets?: {
        edges: {
          node: {
            note?: { title?: string; createdAt?: string; bodyV2?: { markdown?: string } };
          };
        }[];
      };
    };
  };
  const data = await twentyGraphQL<R>(query, { id: personId });
  const p = data.person;
  if (!p) {
    console.error(`Person ${personId} not found`);
    process.exit(1);
  }

  const name = `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim();
  console.log('=== ' + (name || personId) + ' ===');
  console.log(`Email:           ${p.emails?.primaryEmail ?? '-'}`);
  console.log(`Title:           ${p.jobTitle ?? '-'}`);
  console.log(`Company:         ${p.company?.name ?? '-'}`);
  console.log(`Research status: ${p.researchStatus ?? '-'}`);
  console.log(`Gmail draft:     ${p.gmailDraftId ?? '-'}`);
  console.log('');
  console.log('--- TOP ANGLE ---');
  console.log(p.hookSummary ?? '(none)');
  console.log('');

  const notes = (p.noteTargets?.edges ?? [])
    .map((e) => e.node.note)
    .filter((n): n is { title?: string; createdAt?: string; bodyV2?: { markdown?: string } } => !!n)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  // Show the two most recent — the pipeline writes brief + brainstorm per run.
  const recent = notes.slice(0, 2);
  for (const n of recent) {
    console.log('='.repeat(60));
    console.log(n.title ?? '(untitled note)');
    console.log('='.repeat(60));
    console.log(n.bodyV2?.markdown ?? '(empty)');
    console.log('');
  }

  if (p.emailDraftFinal?.markdown) {
    console.log('--- FINAL EMAIL (manually written) ---');
    console.log(p.emailDraftFinal.markdown);
    console.log('');
  }
  if (p.company?.researchSummary?.markdown) {
    console.log('--- COMPANY SUMMARY ---');
    console.log(p.company.researchSummary.markdown);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
