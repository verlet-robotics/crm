// Restructures the Company object's table views so the CRM separates the four
// kinds of account into their own filtered pages, instead of one cluttered list:
//
//   Companies            accountType = COMPANY              (potential clients)
//   Labs & Institutions  accountType = LAB | INSTITUTION    (academic prospects)
//   Investors            accountType = INVESTOR             (different GTM motion)
//   Misc                 accountType = MISC                 (everything else)
//
// Each is a TABLE view filtered on accountType. Favorite each one in the Twenty
// UI (hover the view → star) to surface it as its own left-sidebar entry — the
// favorites API is not exposed to API keys, so that final click is manual.
//
// Idempotent: re-runs reconcile names + filters without duplicating views. The
// default "All Companies" INDEX view and the "GTM Pipeline" kanban are left
// untouched.
//
// Run with: yarn nx run twenty-outreach-research:setup:install-company-views
import { twentyMetadataGraphQL } from '../lib/twenty-client.js';

type View = {
  id: string;
  name: string;
  key: string | null;
  type: string;
  icon: string | null;
  position: number;
};
type ViewFilter = {
  id: string;
  fieldMetadataId: string;
  operand: string;
  value: unknown;
};
type ViewField = {
  fieldMetadataId: string;
  position: number;
  isVisible: boolean;
  size: number;
  aggregateOperation: string | null;
};

// Desired account-type views, in sidebar order. `match` lists prior names this
// view may currently carry, so a re-run repurposes an existing view (preserving
// its column layout + any favorite) instead of creating a duplicate.
const DESIRED_VIEWS: {
  name: string;
  icon: string;
  accountTypes: string[];
  match: string[];
}[] = [
  { name: 'Companies', icon: 'IconBuildingSkyscraper', accountTypes: ['COMPANY'], match: ['GTM Companies'] },
  { name: 'Labs & Institutions', icon: 'IconFlask', accountTypes: ['LAB', 'INSTITUTION'], match: ['Labs'] },
  { name: 'Investors', icon: 'IconCash', accountTypes: ['INVESTOR'], match: [] },
  { name: 'Misc', icon: 'IconArchive', accountTypes: ['MISC'], match: [] },
];

type ViewSort = { id: string; fieldMetadataId: string; direction: string };

const fetchCompanyMeta = async (): Promise<{
  objectId: string;
  accountTypeFieldId: string;
  outreachStageFieldId: string;
}> => {
  const query = `
    query ObjectsMeta {
      objects(paging: { first: 200 }) {
        edges {
          node {
            id
            nameSingular
            fields(paging: { first: 500 }) { edges { node { id name } } }
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
          fields: { edges: { node: { id: string; name: string } }[] };
        };
      }[];
    };
  };
  const data = await twentyMetadataGraphQL<Result>(query);
  const company = data.objects.edges.find((e) => e.node.nameSingular === 'company')?.node;
  if (!company) throw new Error('Company object not found in metadata');
  const accountType = company.fields.edges.find((e) => e.node.name === 'accountType')?.node;
  if (!accountType) {
    throw new Error('Company.accountType field not found — run the migration setup first');
  }
  const outreachStage = company.fields.edges.find((e) => e.node.name === 'outreachStage')?.node;
  if (!outreachStage) {
    throw new Error('Company.outreachStage field not found — run setup:install-fields first');
  }
  return {
    objectId: company.id,
    accountTypeFieldId: accountType.id,
    outreachStageFieldId: outreachStage.id,
  };
};

const getViews = async (objectId: string): Promise<View[]> => {
  const data = await twentyMetadataGraphQL<{ getViews: View[] }>(
    `query Views($id: String!) { getViews(objectMetadataId: $id) { id name key type icon position } }`,
    { id: objectId },
  );
  return data.getViews;
};

const getViewFilters = async (viewId: string): Promise<ViewFilter[]> => {
  const data = await twentyMetadataGraphQL<{ getViewFilters: ViewFilter[] }>(
    `query Filters($id: String!) { getViewFilters(viewId: $id) { id fieldMetadataId operand value } }`,
    { id: viewId },
  );
  return data.getViewFilters;
};

const getViewFields = async (viewId: string): Promise<ViewField[]> => {
  const data = await twentyMetadataGraphQL<{ getViewFields: ViewField[] }>(
    `query Fields($id: String!) { getViewFields(viewId: $id) { fieldMetadataId position isVisible size aggregateOperation } }`,
    { id: viewId },
  );
  return data.getViewFields;
};

const createView = async (input: {
  objectMetadataId: string;
  name: string;
  icon: string;
  position: number;
}): Promise<string> => {
  const data = await twentyMetadataGraphQL<{ createView: { id: string } }>(
    `mutation CreateView($input: CreateViewInput!) { createView(input: $input) { id } }`,
    { input: { ...input, type: 'TABLE' } },
  );
  return data.createView.id;
};

const updateView = async (id: string, input: Record<string, unknown>): Promise<void> => {
  await twentyMetadataGraphQL(
    `mutation UpdateView($id: String!, $input: UpdateViewInput!) { updateView(id: $id, input: $input) { id } }`,
    { id, input: { id, ...input } },
  );
};

const cloneViewFields = async (sourceViewId: string, targetViewId: string): Promise<void> => {
  const fields = await getViewFields(sourceViewId);
  if (fields.length === 0) return;
  await twentyMetadataGraphQL(
    `mutation CreateManyViewFields($inputs: [CreateViewFieldInput!]!) {
      createManyViewFields(inputs: $inputs) { id }
    }`,
    {
      inputs: fields.map((f) => ({
        viewId: targetViewId,
        fieldMetadataId: f.fieldMetadataId,
        position: f.position,
        isVisible: f.isVisible,
        size: f.size,
        aggregateOperation: f.aggregateOperation,
      })),
    },
  );
};

const getViewSorts = async (viewId: string): Promise<ViewSort[]> => {
  const data = await twentyMetadataGraphQL<{ getViewSorts: ViewSort[] }>(
    `query Sorts($id: String!) { getViewSorts(viewId: $id) { id fieldMetadataId direction } }`,
    { id: viewId },
  );
  return data.getViewSorts;
};

const deleteViewSort = async (id: string): Promise<void> => {
  await twentyMetadataGraphQL(
    `mutation DeleteViewSort($input: DeleteViewSortInput!) { deleteViewSort(input: $input) { id } }`,
    { input: { id } },
  );
};

// Ensure the view is sorted by stage (outreachStage DESC = most-advanced first,
// CLOSED_LOST → IDENTIFIED) so the furthest-along accounts sit at the top.
// Leaves sorts on other fields alone.
const ensureStageSort = async (viewId: string, outreachStageFieldId: string): Promise<void> => {
  const sorts = await getViewSorts(viewId);
  const stageSorts = sorts.filter((s) => s.fieldMetadataId === outreachStageFieldId);
  if (stageSorts.length === 1 && stageSorts[0].direction === 'DESC') {
    console.log('    sort ok (stage)');
    return;
  }
  for (const s of stageSorts) await deleteViewSort(s.id);
  await twentyMetadataGraphQL(
    `mutation CreateViewSort($input: CreateViewSortInput!) { createViewSort(input: $input) { id } }`,
    { input: { viewId, fieldMetadataId: outreachStageFieldId, direction: 'DESC' } },
  );
  console.log('    sort set → stage (DESC)');
};

const deleteViewFilter = async (id: string): Promise<void> => {
  await twentyMetadataGraphQL(
    `mutation DeleteViewFilter($input: DeleteViewFilterInput!) { deleteViewFilter(input: $input) { id } }`,
    { input: { id } },
  );
};

const createAccountTypeFilter = async (
  viewId: string,
  fieldMetadataId: string,
  accountTypes: string[],
): Promise<void> => {
  await twentyMetadataGraphQL(
    `mutation CreateViewFilter($input: CreateViewFilterInput!) { createViewFilter(input: $input) { id } }`,
    {
      input: {
        viewId,
        fieldMetadataId,
        operand: 'IS',
        // SELECT filters store a JSON-stringified array of option values.
        value: JSON.stringify(accountTypes),
      },
    },
  );
};

const sameValueSet = (stored: unknown, desired: string[]): boolean => {
  let parsed: unknown = stored;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed)) return false;
  const a = [...(parsed as string[])].sort();
  const b = [...desired].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

// Ensure the view has exactly the desired accountType filter. Non-accountType
// filters are left alone; divergent accountType filters are replaced.
const ensureFilter = async (
  view: View,
  accountTypeFieldId: string,
  accountTypes: string[],
): Promise<void> => {
  const filters = await getViewFilters(view.id);
  const accountTypeFilters = filters.filter((f) => f.fieldMetadataId === accountTypeFieldId);
  const correct =
    accountTypeFilters.length === 1 &&
    accountTypeFilters[0].operand === 'IS' &&
    sameValueSet(accountTypeFilters[0].value, accountTypes);
  if (correct) {
    console.log(`    filter ok (${accountTypes.join(', ')})`);
    return;
  }
  for (const f of accountTypeFilters) await deleteViewFilter(f.id);
  await createAccountTypeFilter(view.id, accountTypeFieldId, accountTypes);
  console.log(`    filter set → ${accountTypes.join(', ')}`);
};

const main = async () => {
  const { objectId, accountTypeFieldId, outreachStageFieldId } = await fetchCompanyMeta();
  const views = await getViews(objectId);

  // A template for column layout when creating a brand-new view: any existing
  // non-index TABLE view works (they share the Company column set).
  const templateView = views.find((v) => v.type === 'TABLE' && v.key !== 'INDEX');

  let position = 1; // 0 is the default "All Companies" INDEX view
  for (const desired of DESIRED_VIEWS) {
    console.log(`• ${desired.name}`);
    // Find an existing view by target name, then by any prior name to repurpose.
    let view =
      views.find((v) => v.name.toLowerCase() === desired.name.toLowerCase()) ??
      views.find((v) => desired.match.some((m) => m.toLowerCase() === v.name.toLowerCase()));

    if (view) {
      const updates: Record<string, unknown> = {};
      if (view.name !== desired.name) updates.name = desired.name;
      if (view.icon !== desired.icon) updates.icon = desired.icon;
      if (view.position !== position) updates.position = position;
      if (Object.keys(updates).length > 0) {
        await updateView(view.id, updates);
        console.log(`    updated ${JSON.stringify(updates)}`);
      } else {
        console.log('    metadata ok');
      }
    } else {
      const newId = await createView({
        objectMetadataId: objectId,
        name: desired.name,
        icon: desired.icon,
        position,
      });
      if (templateView) await cloneViewFields(templateView.id, newId);
      view = { id: newId, name: desired.name, key: null, type: 'TABLE', icon: desired.icon, position };
      console.log('    created');
    }

    await ensureFilter(view, accountTypeFieldId, desired.accountTypes);
    await ensureStageSort(view.id, outreachStageFieldId);
    position++;
  }

  console.log('\nDone. Favorite each view in Twenty (hover the view tab → ☆) to');
  console.log('pin it as its own left-sidebar entry.');
};

main().catch((err) => {
  console.error('install-company-views FAILED');
  console.error(err);
  process.exit(1);
});
