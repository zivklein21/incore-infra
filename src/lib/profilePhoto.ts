import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from './s3';

// `import sharp from 'sharp'` type-checks fine but compiles to
// `sharp_1.default(...)` under this project's commonjs tsconfig — sharp's
// real export is a bare `module.exports = fn`, so `.default` is undefined
// and every call throws "sharp_1.default is not a function" at runtime
// despite a clean `tsc` pass. `import ... = require()` binds directly to the
// raw CJS export, sidestepping the ESM-flavored .d.mts sharp's package.json
// points "types" at. Same workaround as the original Firebase function.
// Separately: sharp ships a native binary per platform — the Lambda deploy
// package must be built/installed with `--platform=linux --arch=x64` (or
// arm64, matching the Lambda architecture), not just `npm install` on a Mac.
interface SharpChain {
  resize: (width: number, height: number, opts: { fit: string }) => SharpChain;
  jpeg: (opts: { quality: number }) => SharpChain;
  toBuffer: () => Promise<Buffer>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as (input: Buffer) => SharpChain;

const MAX_DIMENSION = 500;
const JPEG_QUALITY = 75;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function resizeStoragePhoto(storagePath: string): Promise<{ resized: boolean; beforeBytes: number; afterBytes: number }> {
  const getRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: storagePath }));
  const buffer = await streamToBuffer(getRes.Body as NodeJS.ReadableStream);

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'cover' })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  if (resized.length >= buffer.length) {
    return { resized: false, beforeBytes: buffer.length, afterBytes: buffer.length };
  }

  const headRes = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: storagePath }));
  const existingToken = headRes.Metadata?.firebasestoragedownloadtokens;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: storagePath,
    Body: resized,
    ContentType: 'image/jpeg',
    Metadata: {
      resized: 'true',
      ...(existingToken ? { firebasestoragedownloadtokens: existingToken } : {}),
    },
  }));

  return { resized: true, beforeBytes: buffer.length, afterBytes: resized.length };
}
