// Creates + ACTIVATES the Twenty "Workflows" that become trigger buttons for
// the outreach pipeline — fully hands-off, no clicking in the UI.
//
// Each workflow is a MANUAL-trigger workflow whose single step is an HTTP
// Request that POSTs to the deployed trigger server (src/server/trigger-server.ts).
// Two are per-record (Person / Company) and two are global (run-pending,
// discovery-scan).
//
// WHY A USER TOKEN (not the API key):
//   Twenty hard-blocks the workflow-builder mutations (createWorkflowVersionStep,
//   activateWorkflowVersion) to logged-in USER sessions — an API key gets 403.
//   So this script authenticates with a user access token instead.
//
//   Prod uses Google SSO (AUTH_PASSWORD_ENABLED=false), so the token can't be
//   minted from email+password here. Grab it from your already-logged-in browser
//   (one copy-paste):
//     1. Open Twenty (crm.verlet.co) while logged in.
//     2. DevTools → Application → Cookies → copy the value of the `tokenPair`
//        cookie, OR run this in the DevTools Console:
//          JSON.parse(decodeURIComponent(document.cookie.split('tokenPair=')[1].split(';')[0])).accessOrWorkspaceAgnosticToken.token
//     3. Pass it as OUTREACH_TWENTY_USER_TOKEN.
//   (The token is short-lived — run this script soon after copying it.)
//
// Idempotent: skips any workflow whose name already exists (and tries to ensure
// it's active).
//
// Usage:
//   OUTREACH_TWENTY_USER_TOKEN=<browser token> \
//   OUTREACH_TRIGGER_URL=https://outreach-trigger-production.up.railway.app \
//   OUTREACH_TRIGGER_TOKEN=<server token> \
//   TWENTY_API_URL=https://crm.verlet.co \
//   tsx src/setup/install-trigger-workflows.ts
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const API_URL = (process.env.TWENTY_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const USER_TOKEN = process.env.OUTREACH_TWENTY_USER_TOKEN;
const TRIGGER_URL = process.env.OUTREACH_TRIGGER_URL?.replace(/\/$/, '');
const TRIGGER_TOKEN = process.env.OUTREACH_TRIGGER_TOKEN;

if (!USER_TOKEN) {
  console.error(
    'Set OUTREACH_TWENTY_USER_TOKEN — a logged-in user access token from your\n' +
      'browser (the `tokenPair` cookie). See the header of this file for how to grab it.',
  );
  process.exit(2);
}
if (!TRIGGER_URL || !TRIGGER_TOKEN) {
  console.error('Set OUTREACH_TRIGGER_URL and OUTREACH_TRIGGER_TOKEN (the deployed trigger server).');
  process.exit(2);
}

// Core GraphQL call authenticated as the USER (workflow-builder mutations live
// on the core schema and require a user session).
const coreGraphQL = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
  const res = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${USER_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data as T;
};

type Availability =
  | { type: 'SINGLE_RECORD'; objectNameSingular: string }
  | { type: 'GLOBAL' };

type WorkflowSpec = {
  name: string;
  icon: string;
  path: string;
  availability: Availability;
  body: Record<string, unknown>;
};

const WORKFLOWS: WorkflowSpec[] = [
  {
    name: 'Research this Person',
    icon: 'IconSearch',
    path: '/triggers/research-person',
    availability: { type: 'SINGLE_RECORD', objectNameSingular: 'person' },
    body: { personId: '{{trigger.record.id}}' },
  },
  {
    name: 'Research this Company',
    icon: 'IconSearch',
    path: '/triggers/research-company',
    availability: { type: 'SINGLE_RECORD', objectNameSingular: 'company' },
    body: { companyId: '{{trigger.record.id}}' },
  },
  {
    name: 'Run pending research (backlog)',
    icon: 'IconPlayerPlay',
    path: '/triggers/run-pending',
    availability: { type: 'GLOBAL' },
    body: {},
  },
  {
    name: 'Run discovery scan',
    icon: 'IconRadar',
    path: '/triggers/discovery-scan',
    availability: { type: 'GLOBAL' },
    body: {},
  },
];

const buildTrigger = (spec: WorkflowSpec) => ({
  name: spec.name,
  type: 'MANUAL',
  settings: {
    outputSchema: {},
    icon: spec.icon,
    isPinned: spec.availability.type === 'SINGLE_RECORD',
    availability: spec.availability,
  },
  position: { x: 0, y: 0 },
});

// Full HTTP-request action settings written via updateWorkflowVersionStep.
const buildHttpStepSettings = (spec: WorkflowSpec) => ({
  input: {
    url: `${TRIGGER_URL}${spec.path}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TRIGGER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: spec.body,
  },
  outputSchema: {},
  errorHandlingOptions: {
    retryOnFailure: { value: false },
    continueOnFailure: { value: false },
  },
});

const findExistingWorkflowByName = async (name: string): Promise<string | null> => {
  type Result = { workflows: { edges: { node: { id: string } }[] } };
  const data = await coreGraphQL<Result>(
    `query FindWorkflow($name: String!) {
       workflows(filter: { name: { eq: $name } }, first: 1) { edges { node { id } } }
     }`,
    { name },
  );
  return data.workflows.edges[0]?.node.id ?? null;
};

const getDraftVersionId = async (workflowId: string): Promise<string> => {
  type Result = {
    workflow: { versions: { edges: { node: { id: string; status: string } }[] } };
  };
  const data = await coreGraphQL<Result>(
    `query Wf($id: UUID!) {
       workflow(filter: { id: { eq: $id } }) {
         versions { edges { node { id status } } }
       }
     }`,
    { id: workflowId },
  );
  const versions = data.workflow.versions.edges.map((e) => e.node);
  const draft = versions.find((v) => v.status === 'DRAFT') ?? versions[0];
  if (!draft) throw new Error('no workflow version found');
  return draft.id;
};

const createOneWorkflow = async (spec: WorkflowSpec): Promise<void> => {
  if (await findExistingWorkflowByName(spec.name)) {
    console.log(`[skip] "${spec.name}" already exists`);
    return;
  }

  const workflowId = randomUUID();

  // 1. Create the workflow (auto-creates a DRAFT version with empty trigger/steps).
  await coreGraphQL(
    `mutation CreateWorkflow($data: WorkflowCreateInput!) {
       createWorkflow(data: $data) { id }
     }`,
    { data: { id: workflowId, name: spec.name } },
  );

  const versionId = await getDraftVersionId(workflowId);

  // 2. Set the manual trigger (record-API update; trigger-only is permitted).
  await coreGraphQL(
    `mutation SetTrigger($id: UUID!, $data: WorkflowVersionUpdateInput!) {
       updateWorkflowVersion(id: $id, data: $data) { id }
     }`,
    { id: versionId, data: { trigger: buildTrigger(spec) } },
  );

  // 3. Add the HTTP_REQUEST step via the builder mutation (user-session only).
  // We pass our own step id and confirm it appears in the returned stepsDiff —
  // this is exactly how Twenty's own frontend (useCreateStep) does it.
  const stepId = randomUUID();
  type StepChanges = { createWorkflowVersionStep: { triggerDiff: unknown; stepsDiff: unknown[] } };
  const changes = await coreGraphQL<StepChanges>(
    `mutation AddStep($input: CreateWorkflowVersionStepInput!) {
       createWorkflowVersionStep(input: $input) { triggerDiff stepsDiff }
     }`,
    { input: { id: stepId, workflowVersionId: versionId, stepType: 'HTTP_REQUEST' } },
  );
  const diff = (changes.createWorkflowVersionStep.stepsDiff ?? []) as {
    type: string;
    value?: unknown;
  }[];
  const created = diff.some(
    (d) =>
      (d.type === 'CREATE' && (d.value as { id?: string })?.id === stepId) ||
      (d.type === 'CHANGE' &&
        Array.isArray(d.value) &&
        (d.value[0] as { id?: string })?.id === stepId),
  );
  if (!created) throw new Error('createWorkflowVersionStep did not report our step id in stepsDiff');

  // 4. Fill in the step's HTTP settings (url, headers, body).
  await coreGraphQL(
    `mutation UpdateStep($input: UpdateWorkflowVersionStepInput!) {
       updateWorkflowVersionStep(input: $input) { id type }
     }`,
    {
      input: {
        workflowVersionId: versionId,
        step: {
          id: stepId,
          name: spec.name,
          type: 'HTTP_REQUEST',
          valid: true,
          settings: buildHttpStepSettings(spec),
        },
      },
    },
  );

  // 5. Activate — registers the command-menu item / record button.
  await coreGraphQL(
    `mutation Activate($id: UUID!) { activateWorkflowVersion(workflowVersionId: $id) }`,
    { id: versionId },
  );

  console.log(`[done] "${spec.name}" — created, configured, ACTIVE`);
};

const main = async (): Promise<void> => {
  console.log(`Twenty: ${API_URL}`);
  console.log(`Trigger server: ${TRIGGER_URL}`);
  console.log(`Creating + activating ${WORKFLOWS.length} workflows…\n`);

  for (const spec of WORKFLOWS) {
    try {
      await createOneWorkflow(spec);
    } catch (err) {
      console.error(`[FAILED] "${spec.name}": ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(
    [
      '',
      'Done. Active buttons:',
      '  • "Research this Person"  → button on every Person record',
      '  • "Research this Company" → button on every Company record',
      '  • "Run pending research"  → global command menu (Cmd/Ctrl-K)',
      '  • "Run discovery scan"    → global command menu',
      '',
      'Any [FAILED] above usually means the user token expired — re-grab it and rerun.',
    ].join('\n'),
  );
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
