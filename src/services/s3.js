import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION || 'auto';
const bucket = process.env.S3_BUCKET;

if (!endpoint || !bucket) {
  throw new Error('S3_ENDPOINT / S3_BUCKET is required');
}

export const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: true, // R2 / many S3-compatible endpoints prefer path-style
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  }
});

// Create a presigned PUT URL for direct upload
export async function createUploadPut({ key, contentType, ttlSec }) {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttlSec });
  return {
    url,
    bucket,
    key,
    method: 'PUT',
    headers: { 'Content-Type': contentType }
  };
}

// Create a presigned GET URL for downloading the object (still ciphertext)
export async function createDownloadGet({ key, ttlSec, downloadName }) {
  // Optional existence check to fail early
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // ignore: we still return a signed URL; caller can handle 404 on GET
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttlSec });
  return { url, bucket, key };
}

export async function deleteObject({ key }) {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key
  }));
}

export async function deleteAllWithPrefix({ prefix }) {
  if (!prefix) return { deleted: 0 };
  let continuationToken = null;
  let deleted = 0;
  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken || undefined
    }));
    const objects = Array.isArray(listRes.Contents)
      ? listRes.Contents.map((item) => ({ Key: item.Key })).filter((obj) => obj.Key)
      : [];
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects }
      }));
      deleted += objects.length;
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : null;
  } while (continuationToken);
  return { deleted };
}
