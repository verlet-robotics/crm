// Installs custom fields on Person (and a couple on Company) used by the
// outreach-research pipeline. Idempotent — re-runs are safe.
//
// Run with: yarn nx run twenty-outreach-research:setup:install-fields
import { twentyMetadataGraphQL } from '../lib/twenty-client.js';

type ObjectMeta = { id: string; nameSingular: string; fields: { name: string }[] };

const fetchObjectMeta = async (nameSingular: string): Promise<ObjectMeta> => {
  const query = `
    query ObjectsMeta {
      objects(paging: { first: 200 }) {
        edges {
          node {
            id
            nameSingular
            fields(paging: { first: 500 }) { edges { node { name } } }
          }
        }
      }
    }
  `;
  type Result = {
    objects: {
      edges: {
        node: {
          id: string;
          nameSingular: string;
          fields: { edges: { node: { name: string } }[] };
        };
      }[];
    };
  };
  const data = await twentyMetadataGraphQL<Result>(query);
  const node = data.objects.edges.find((e) => e.node.nameSingular === nameSingular)?.node;
  if (!node) throw new Error(`Object "${nameSingular}" not found in metadata`);
  return {
    id: node.id,
    nameSingular: node.nameSingular,
    fields: node.fields.edges.map((e) => e.node),
  };
};

type FieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'RICH_TEXT'
  | 'DATE_TIME';

type FieldSpec = {
  name: string;
  label: string;
  type: FieldType;
  description?: string;
  options?: { value: string; label: string; color: string; position: number }[];
};

const createField = async (objectMetadataId: string, spec: FieldSpec): Promise<void> => {
  const mutation = `
    mutation CreateField($input: CreateOneFieldMetadataInput!) {
      createOneField(input: $input) { id name }
    }
  `;
  await twentyMetadataGraphQL(mutation, {
    input: {
      field: {
        name: spec.name,
        label: spec.label,
        type: spec.type,
        description: spec.description,
        objectMetadataId,
        isNullable: true,
        ...(spec.options && { options: spec.options }),
      },
    },
  });
};

const ensureFields = async (objectName: string, specs: FieldSpec[]): Promise<void> => {
  const meta = await fetchObjectMeta(objectName);
  const existing = new Set(meta.fields.map((f) => f.name));

  for (const spec of specs) {
    if (existing.has(spec.name)) {
      console.log(`  ✓ ${objectName}.${spec.name} already exists`);
      continue;
    }
    console.log(`  + ${objectName}.${spec.name} (${spec.type})`);
    try {
      await createField(meta.id, spec);
    } catch (err) {
      console.error(`    FAILED:`, err instanceof Error ? err.message : err);
      throw err;
    }
  }
};

// NOTE — the legacy migration package at /Users/mats2/Documents/GTM/migration
// already owns these Company fields (created via the Twenty UI per HANDOFF.md):
//   accountType (Company/Lab/Institution), country, dataNeed (Ego/UMI/Teleop),
//   notionPageUrl
// And Opportunity.stage is already retuned to:
//   NOT_CONTACTED, CONTACTED, REPLIED, PILOT_DISCUSSION, PILOT_SIGNED, CUSTOMER, LOST
//
// This script ONLY installs the additional fields needed by the deep-research
// pipeline. It does not touch the fields above; if they're missing, run the
// migration setup first (see migration/HANDOFF.md).

const personFields: FieldSpec[] = [
  {
    name: 'researchStatus',
    label: 'Research Status',
    type: 'SELECT',
    description:
      'Where this Person sits in the deep-research pipeline. Per-contact pipeline state; the deal funnel is on Opportunity.stage.',
    options: [
      { value: 'NEEDS_RESEARCH', label: 'Needs research', color: 'gray', position: 0 },
      { value: 'RESEARCHING', label: 'Researching', color: 'yellow', position: 1 },
      { value: 'RESEARCH_DONE', label: 'Research done', color: 'blue', position: 2 },
      { value: 'DRAFTING', label: 'Drafting', color: 'yellow', position: 3 },
      { value: 'DRAFTED', label: 'Drafted', color: 'purple', position: 4 },
      { value: 'NEEDS_REDRAFT', label: 'Needs redraft', color: 'orange', position: 5 },
      { value: 'APPROVED', label: 'Approved', color: 'green', position: 6 },
      { value: 'SENT', label: 'Sent', color: 'green', position: 7 },
      { value: 'REPLIED', label: 'Replied', color: 'pink', position: 8 },
      { value: 'SKIPPED', label: 'Skipped', color: 'gray', position: 9 },
    ],
  },
  {
    name: 'outreachRole',
    label: 'Outreach Role',
    type: 'SELECT',
    description:
      'For commercial companies: the recommended contact role from run-for-company. Business picks get a light role-angle from the company brief; technical picks get full per-person research. Empty for non-recommended contacts and for lab members (researched individually).',
    options: [
      { value: 'BUSINESS_PRIMARY', label: 'Business · Primary', color: 'blue', position: 0 },
      { value: 'BUSINESS_BACKUP', label: 'Business · Backup', color: 'sky', position: 1 },
      { value: 'TECHNICAL_PRIMARY', label: 'Technical · Primary', color: 'purple', position: 2 },
      { value: 'TECHNICAL_BACKUP', label: 'Technical · Backup', color: 'pink', position: 3 },
      { value: 'NOT_SELECTED', label: 'Not selected', color: 'gray', position: 4 },
    ],
  },
  {
    name: 'emailDraftV1',
    label: 'Email Draft (short)',
    type: 'RICH_TEXT',
    description: 'Tight ~120-word draft. Filled by L3.',
  },
  {
    name: 'emailDraftV2',
    label: 'Email Draft (long)',
    type: 'RICH_TEXT',
    description: 'Longer ~200-word draft. Filled by L3.',
  },
  {
    name: 'emailDraftFinal',
    label: 'Final Email (edited)',
    type: 'RICH_TEXT',
    description: 'Human-edited version that actually gets sent.',
  },
  {
    name: 'judgeScore',
    label: 'Judge Score',
    type: 'NUMBER',
    description: 'Independent-model score 0–25 across 5 dimensions.',
  },
  {
    name: 'judgeNotes',
    label: 'Judge Notes',
    type: 'TEXT',
    description: 'Reasons behind the judge score; what the human should look at.',
  },
  {
    name: 'gmailDraftId',
    label: 'Gmail Draft ID',
    type: 'TEXT',
    description: 'Gmail draft resource ID, populated by L6 send step.',
  },
  {
    name: 'hookSummary',
    label: 'Hook',
    type: 'TEXT',
    description: 'One-line summary of the personalization angle (their recent paper, funding, etc.).',
  },
  {
    name: 'emailConfidence',
    label: 'Email Confidence',
    type: 'SELECT',
    description:
      'Deliverability confidence on this contact\'s email. VERIFIED = Hunter found it on a real page / verifier says deliverable; RISKY = catch-all/webmail/unknown; GUESSED = derived from a pattern (treat as a hypothesis). Drives a send-time deliverability warning.',
    options: [
      { value: 'VERIFIED', label: 'Verified', color: 'green', position: 0 },
      { value: 'RISKY', label: 'Risky', color: 'orange', position: 1 },
      { value: 'GUESSED', label: 'Guessed', color: 'red', position: 2 },
      { value: 'UNVERIFIED', label: 'Unverified', color: 'gray', position: 3 },
    ],
  },
  {
    name: 'discoverySource',
    label: 'Discovery Source',
    type: 'SELECT',
    description: 'How this Person landed in the pipeline. Set by L1 discovery scripts.',
    options: [
      { value: 'MANUAL', label: 'Manual', color: 'gray', position: 0 },
      { value: 'NOTION_IMPORT', label: 'Notion import', color: 'gray', position: 1 },
      { value: 'ARXIV', label: 'arXiv daily', color: 'blue', position: 2 },
      { value: 'EXA_SIMILAR', label: 'Exa findSimilar', color: 'purple', position: 3 },
      { value: 'APOLLO', label: 'Apollo org-chart', color: 'green', position: 4 },
      { value: 'SEMANTIC_SCHOLAR', label: 'Semantic Scholar', color: 'orange', position: 5 },
      { value: 'GITHUB', label: 'GitHub contributor', color: 'pink', position: 6 },
      { value: 'CITATIONS', label: 'Citation walker', color: 'turquoise', position: 7 },
      { value: 'COAUTHOR', label: 'Co-author expansion', color: 'yellow', position: 8 },
      { value: 'ENRICHMENT', label: 'Stage 2 enrichment', color: 'sky', position: 9 },
      { value: 'INSTITUTION_SCAN', label: 'Stage 1 institution scan', color: 'red', position: 10 },
      { value: 'FUNDING_NEWS', label: 'Stage 1 funding news', color: 'red', position: 11 },
    ],
  },
  {
    name: 'discoveryRef',
    label: 'Discovery Reference',
    type: 'TEXT',
    description: 'Source-specific identifier (arXiv URL, similar-paper URL, Apollo ID).',
  },
  {
    name: 'gmailThreadId',
    label: 'Gmail Thread ID',
    type: 'TEXT',
    description: 'Gmail thread resource ID — used by the reply watcher.',
  },
  {
    name: 'gmailMessageId',
    label: 'Gmail Message ID',
    type: 'TEXT',
    description: 'Gmail message resource ID once the draft has been sent.',
  },
  {
    name: 'lastSentAt',
    label: 'Last Sent At',
    type: 'DATE_TIME',
    description: 'When the outreach email was actually sent. Populated when reply-watcher detects the draft left the Drafts folder.',
  },
  {
    name: 'replyDisposition',
    label: 'Reply Disposition',
    type: 'SELECT',
    description: 'Classifier output once a reply lands.',
    options: [
      { value: 'POSITIVE', label: 'Positive', color: 'green', position: 0 },
      { value: 'QUESTION', label: 'Question', color: 'blue', position: 1 },
      { value: 'NEGATIVE', label: 'Negative', color: 'red', position: 2 },
      { value: 'UNSUBSCRIBE', label: 'Unsubscribe', color: 'orange', position: 3 },
      { value: 'OUT_OF_OFFICE', label: 'OOO/Auto-reply', color: 'gray', position: 4 },
      { value: 'UNCLEAR', label: 'Unclear', color: 'gray', position: 5 },
    ],
  },
];

const companyFields: FieldSpec[] = [
  {
    name: 'outreachStage',
    label: 'Outreach Stage',
    type: 'SELECT',
    description:
      'Account-level GTM pipeline state — drives the Company Kanban. Auto-advanced by the pipeline through IDENTIFIED..IN_CONVERSATION (derived from this company\'s People researchStatus); PILOT/CLOSED_WON/CLOSED_LOST are set manually and never overridden by the pipeline.',
    options: [
      { value: 'IDENTIFIED', label: 'Identified', color: 'gray', position: 0 },
      { value: 'CANDIDATES_FOUND', label: 'Candidates Found', color: 'blue', position: 1 },
      { value: 'RESEARCHING', label: 'Researching', color: 'yellow', position: 2 },
      { value: 'OUTREACH_SENT', label: 'Outreach Sent', color: 'purple', position: 3 },
      { value: 'IN_CONVERSATION', label: 'In Conversation', color: 'pink', position: 4 },
      { value: 'PILOT', label: 'Pilot', color: 'sky', position: 5 },
      { value: 'CLOSED_WON', label: 'Closed Won', color: 'green', position: 6 },
      { value: 'CLOSED_LOST', label: 'Closed Lost', color: 'red', position: 7 },
    ],
  },
  {
    name: 'researchSummary',
    label: 'Research Summary',
    type: 'RICH_TEXT',
    description:
      'Org-level brief — funding, products, hiring signals. Shared across People at this org. Refreshed by L2 weekly.',
  },
  {
    name: 'pendingReview',
    label: 'Pending Review',
    type: 'BOOLEAN',
    description:
      'Stage 1 institution-discovery flag. TRUE = scanner surfaced this org; you should triage it. Clear once you set accountType (or delete the row).',
  },
  {
    name: 'discoverySource',
    label: 'Discovery Source',
    type: 'SELECT',
    description: 'How this Company landed in the pipeline. Set by Stage 1 institution scanners.',
    options: [
      { value: 'MANUAL', label: 'Manual', color: 'gray', position: 0 },
      { value: 'NOTION_IMPORT', label: 'Notion import', color: 'gray', position: 1 },
      { value: 'ARXIV', label: 'arXiv affiliation scan', color: 'blue', position: 2 },
      { value: 'EXA_SIMILAR', label: 'Exa findSimilar', color: 'purple', position: 3 },
      { value: 'APOLLO', label: 'Apollo', color: 'green', position: 4 },
      { value: 'SEMANTIC_SCHOLAR', label: 'Semantic Scholar', color: 'orange', position: 5 },
      { value: 'GITHUB', label: 'GitHub org scan', color: 'pink', position: 6 },
      { value: 'CITATIONS', label: 'Citation walker', color: 'turquoise', position: 7 },
      { value: 'COAUTHOR', label: 'Co-author expansion', color: 'yellow', position: 8 },
      { value: 'ENRICHMENT', label: 'Stage 2 enrichment', color: 'sky', position: 9 },
      { value: 'INSTITUTION_SCAN', label: 'Stage 1 institution scan', color: 'red', position: 10 },
      { value: 'FUNDING_NEWS', label: 'Stage 1 funding news', color: 'red', position: 11 },
    ],
  },
  {
    name: 'discoveryRef',
    label: 'Discovery Reference',
    type: 'TEXT',
    description: 'Provenance string — paper URL, news URL, repo slug, or aggregator key.',
  },
  {
    name: 'signalSummary',
    label: 'Signal Summary',
    type: 'TEXT',
    description:
      'Human-readable one-liner explaining why this org was surfaced. E.g. "5 arXiv papers in last 30d, 2 in cs.RO".',
  },
  {
    name: 'labPageUrl',
    label: 'Lab Page URL',
    type: 'TEXT',
    description:
      'For academic INSTITUTION rows: the URL the Stage 2 academic finder scrapes for the lab roster (e.g. https://apollo-lab.yale.edu/people). Optional — CLI --lab-url overrides.',
  },
  {
    name: 'principalInvestigator',
    label: 'Principal Investigator',
    type: 'TEXT',
    description:
      'For academic INSTITUTION rows: PI\'s full name. Seeds the S2 author lookup for paper-based co-author discovery in Stage 2. Optional — CLI --lab-pi overrides.',
  },
];

const main = async () => {
  console.log('Installing custom fields on Person…');
  await ensureFields('person', personFields);
  console.log('Installing custom fields on Company…');
  await ensureFields('company', companyFields);
  console.log('Done.');
};

main().catch((err) => {
  console.error('install-custom-fields FAILED');
  console.error(err);
  process.exit(1);
});
