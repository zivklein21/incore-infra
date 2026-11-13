import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import type { ClassItem, TrainingTypeItem } from '../entities';

/**
 * Cheap per-session flags for the trainee/parent session lists, so a card
 * knows whether there's a plan or equipment to show and whether to badge it
 * without loading either. The content itself comes from getSessionPlan when
 * the sheet or page opens. One resolver per request: a trainee's sessions
 * almost always share a training type.
 */
export function sessionFlagsResolver(tableName: string) {
  const typeHasEquipment = new Map<string, Promise<boolean>>();
  const checkType = (id: string): Promise<boolean> => {
    let pending = typeHasEquipment.get(id);
    if (!pending) {
      pending = ddb.send(new GetCommand({ TableName: tableName, Key: { PK: `TRAININGTYPE#${id}`, SK: 'METADATA' } }))
        .then((res) => ((res.Item as TrainingTypeItem | undefined)?.equipmentRequirements ?? []).length > 0);
      typeHasEquipment.set(id, pending);
    }
    return pending;
  };

  return async (session: ClassItem) => {
    const { equipmentOverride, planOverride, manualEquipment, trainingTypeId, workoutPlanId } = session;
    const hasEquipment = equipmentOverride
      ? equipmentOverride.items.length > 0
      : (manualEquipment ?? []).length > 0 || (trainingTypeId ? await checkType(trainingTypeId) : false);
    return {
      hasWorkoutPlan: !!workoutPlanId,
      hasSessionEquipment: hasEquipment,
      editedForSession: !!planOverride || !!equipmentOverride,
    };
  };
}
