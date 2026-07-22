import type { DynamoDBStreamEvent } from 'aws-lambda';
import { newImage, oldImage } from '../lib/dynamoStream';
import type { ClassItem, WaitlistEntry } from '../lib/entities';
import { broadcastSpotOpen } from '../lib/waitlistCore';

// DynamoDB Stream trigger — fires on MODIFY of a PK=CLASS#<id> SK=METADATA
// item. Calls broadcastSpotOpen when the number of free slots increases
// (a spot became available for waiting members to claim).
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY') continue;
    const before = oldImage<ClassItem>(record);
    const after = newImage<ClassItem>(record);
    if (!before || !after || after.SK !== 'METADATA' || !after.PK.startsWith('CLASS#')) continue;

    const beforeBooked = before.currentAttendeesCount ?? 0;
    const afterBooked = after.currentAttendeesCount ?? 0;
    const beforeCapacity = before.capacity ?? 5;
    const afterCapacity = after.capacity ?? 5;

    const countWaiting = (wl: WaitlistEntry[] | undefined) => (wl ?? []).filter((e) => e.status === 'waiting').length;
    const beforeWaiting = countWaiting(before.waitlist);
    const afterWaiting = countWaiting(after.waitlist);

    // A spot became available when:
    //  - a booking was cancelled (fewer attendees)
    //  - capacity was raised
    //  - a new member joined the waitlist while a slot was already free
    const slotsFreed = afterBooked < beforeBooked || afterCapacity > beforeCapacity || afterWaiting > beforeWaiting;

    if (slotsFreed) {
      const classId = after.PK.replace('CLASS#', '');
      await broadcastSpotOpen(classId);
    }
  }
}
