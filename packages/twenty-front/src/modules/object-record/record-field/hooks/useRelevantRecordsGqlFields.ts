import { useObjectMetadataItems } from '@/object-metadata/hooks/useObjectMetadataItems';
import { type EnrichedObjectMetadataItem } from '@/object-metadata/types/EnrichedObjectMetadataItem';
import { getImageIdentifierFieldMetadataItem } from '@/object-metadata/utils/getImageIdentifierFieldMetadataItem';
import { getLabelIdentifierFieldMetadataItem } from '@/object-metadata/utils/getLabelIdentifierFieldMetadataItem';
import { hasObjectMetadataItemPositionField } from '@/object-metadata/utils/hasObjectMetadataItemPositionField';
import { generateActivityTargetGqlFields } from '@/object-record/graphql/record-gql-fields/utils/generateActivityTargetGqlFields';
import { CoreObjectNameSingular } from 'twenty-shared/types';

import { generateDepthRecordGqlFieldsFromFields } from '@/object-record/graphql/record-gql-fields/utils/generateDepthRecordGqlFieldsFromFields';
import { visibleRecordFieldsComponentSelector } from '@/object-record/record-field/states/visibleRecordFieldsComponentSelector';
import { currentRecordFiltersComponentState } from '@/object-record/record-filter/states/currentRecordFiltersComponentState';
import { useRecordIndexContextOrThrow } from '@/object-record/record-index/contexts/RecordIndexContext';

import { useAtomComponentSelectorValue } from '@/ui/utilities/state/jotai/hooks/useAtomComponentSelectorValue';
import { useAtomComponentStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomComponentStateValue';
import { filterDuplicatesById, isDefined } from 'twenty-shared/utils';

type UseRecordsUsefulGqlFields = {
  objectMetadataItem: EnrichedObjectMetadataItem;
  additionalFieldMetadataId?: string | null;
};

export const useRelevantRecordsGqlFields = ({
  objectMetadataItem,
  additionalFieldMetadataId,
}: UseRecordsUsefulGqlFields) => {
  const visibleRecordFields = useAtomComponentSelectorValue(
    visibleRecordFieldsComponentSelector,
  );

  const currentRecordFilters = useAtomComponentStateValue(
    currentRecordFiltersComponentState,
  );

  const { fieldMetadataItemByFieldMetadataItemId } =
    useRecordIndexContextOrThrow();

  const { objectMetadataItems } = useObjectMetadataItems();

  const visibleRecordFieldMetadataItems = visibleRecordFields
    .map(
      (field) =>
        fieldMetadataItemByFieldMetadataItemId[field.fieldMetadataItemId],
    )
    .filter(isDefined);

  const recordFilterFields = currentRecordFilters
    .map((recordFilter) =>
      objectMetadataItem.fields.find(
        (field) => field.id === recordFilter.fieldMetadataId,
      ),
    )
    .filter(isDefined);

  const fieldMetadataItemsToUse = [
    ...visibleRecordFieldMetadataItems,
    ...(recordFilterFields ?? []),
  ].filter(filterDuplicatesById);

  const allDepthOneGqlFields = generateDepthRecordGqlFieldsFromFields({
    objectMetadataItems,
    fields: fieldMetadataItemsToUse,
    depth: 1,
  });

  const labelIdentifierFieldMetadataItem =
    getLabelIdentifierFieldMetadataItem(objectMetadataItem);
  const imageIdentifierFieldMetadataItem =
    getImageIdentifierFieldMetadataItem(objectMetadataItem);

  const hasPosition = hasObjectMetadataItemPositionField(objectMetadataItem);

  const additionalFieldMetadataItem = isDefined(additionalFieldMetadataId)
    ? fieldMetadataItemByFieldMetadataItemId[additionalFieldMetadataId]
    : undefined;

  const isObjectAnActivity =
    objectMetadataItem.nameSingular === CoreObjectNameSingular.Note ||
    objectMetadataItem.nameSingular === CoreObjectNameSingular.Task;

  return {
    id: true,
    ...(isDefined(additionalFieldMetadataItem)
      ? { [additionalFieldMetadataItem.name]: true }
      : {}),
    ...(isDefined(labelIdentifierFieldMetadataItem)
      ? { [labelIdentifierFieldMetadataItem.name]: true }
      : {}),
    ...(isDefined(imageIdentifierFieldMetadataItem)
      ? { [imageIdentifierFieldMetadataItem.name]: true }
      : {}),
    ...(hasPosition ? { position: true } : {}),
    ...allDepthOneGqlFields,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    // Only Note/Task boards render their own targets in list/board/calendar views.
    // For every other object these relations were fetched on every card/row but never
    // displayed — a relation join per record that bloats the payload and backend work.
    // Visible noteTargets/taskTargets columns still load via the depth-1 path above.
    ...(isObjectAnActivity
      ? {
          noteTargets: generateActivityTargetGqlFields({
            activityObjectNameSingular: CoreObjectNameSingular.Note,
            objectMetadataItems,
            loadRelations: 'relations',
          }),
          taskTargets: generateActivityTargetGqlFields({
            activityObjectNameSingular: CoreObjectNameSingular.Task,
            objectMetadataItems,
            loadRelations: 'relations',
          }),
        }
      : {}),
  };
};
