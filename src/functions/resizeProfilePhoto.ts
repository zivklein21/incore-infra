import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { resizeStoragePhoto } from '../lib/profilePhoto';

// POST /resizeProfilePhoto
// Auth: Cognito JWT (any signed-in member)
// Called by the client right after it finishes uploading a profile photo,
// before saving the download URL. See src/lib/profilePhoto.ts for the sharp
// packaging notes and functions/src/profilePhotoResize.ts for why this is a
// plain HTTP endpoint rather than a storage-event trigger (the original
// Storage onObjectFinalized trigger never fired reliably).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  let body: { storagePath?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  if (!storagePath || !storagePath.startsWith('profile_photos/')) {
    return json(400, { error: 'invalid_path' });
  }

  try {
    const result = await resizeStoragePhoto(storagePath);
    console.log(`[resizeProfilePhoto] ${storagePath}: ${result.beforeBytes}b -> ${result.afterBytes}b (resized=${result.resized})`);
    return json(200, { success: true, ...result });
  } catch (err: any) {
    console.error(`[resizeProfilePhoto] failed for ${storagePath}:`, err);
    return json(500, { success: false, error: 'resize_failed' });
  }
}
