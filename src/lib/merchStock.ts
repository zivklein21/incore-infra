// Stock adjustments for a MerchProductItem's variant — split out of
// merchPayments.ts/adminRefundMerchOrder.ts since both need the exact same
// "find this variant inside the product's array and adjust its count"
// logic, and getting the two out of sync (e.g. a refund restocking the
// wrong variant) would be a real inventory bug. Both take a single line
// item's (productId, variantId, quantity) rather than a whole order, since
// an order now carries a list of these (see entities.ts's MerchOrderItem)
// and callers loop over it themselves.

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { MerchProductItem } from './entities';

// Called from lib/merchPayments.ts's handleMerchOrderCallback(), once per
// line item, once a purchase is confirmed approved. A ConditionExpression
// guards stock >= quantity so two near-simultaneous purchases of the same
// last few units can't both succeed — the loser still gets a real HYP
// charge (payment already happened before this runs), so callers must
// treat a false return as "flag for admin", not "silently ignore".
export async function decrementVariantStock(merchProductId: string, merchVariantId: string, quantity: number): Promise<boolean> {
  const productRes = await ddb.send(new GetCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MERCHPRODUCT#${merchProductId}`, SK: 'METADATA' },
  }));
  const product = productRes.Item as MerchProductItem | undefined;
  if (!product) return false;

  const variantIndex = product.variants.findIndex((v) => v.id === merchVariantId);
  if (variantIndex === -1 || product.variants[variantIndex].stock < quantity) return false;

  const nextVariants = product.variants.map((v, i) => i === variantIndex ? { ...v, stock: v.stock - quantity } : v);

  try {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MERCHPRODUCT#${merchProductId}`, SK: 'METADATA' },
      UpdateExpression: 'SET variants = :variants',
      ConditionExpression: `variants[${variantIndex}].stock >= :qty`,
      ExpressionAttributeValues: { ':variants': nextVariants, ':qty': quantity },
    }));
    return true;
  } catch {
    // ConditionalCheckFailedException — someone else took the remaining
    // stock between our read above and this write.
    return false;
  }
}

// Called from adminRefundMerchOrder.ts, once per line item — no-op if the
// product/variant was since deleted (nothing sensible to restock), never
// throws for that case since a refund must still succeed even if the
// catalog changed since.
export async function restockVariant(merchProductId: string, merchVariantId: string, quantity: number): Promise<void> {
  const productRes = await ddb.send(new GetCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MERCHPRODUCT#${merchProductId}`, SK: 'METADATA' },
  }));
  const product = productRes.Item as MerchProductItem | undefined;
  if (!product) return;

  const variantIndex = product.variants.findIndex((v) => v.id === merchVariantId);
  if (variantIndex === -1) return;

  const nextVariants = product.variants.map((v, i) => i === variantIndex ? { ...v, stock: v.stock + quantity } : v);
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MERCHPRODUCT#${merchProductId}`, SK: 'METADATA' },
    UpdateExpression: 'SET variants = :variants',
    ExpressionAttributeValues: { ':variants': nextVariants },
  }));
}
