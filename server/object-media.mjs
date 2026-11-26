import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function createObjectMedia({ bucket, endpoint, region, accessKeyId, secretAccessKey }) {
  const client = new S3Client({
    endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const key = (id, filename) => 'media/' + id + '/' + filename;
  async function remove(id) {
    await Promise.all(['original', 'preview.jpg'].map(filename =>
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(id, filename) }))));
  }
  async function put(id, filename, body, contentType) {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key(id, filename), Body: body, ContentType: contentType,
    }));
  }
  async function get(id, filename) {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(id, filename) }));
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async function write(original, prepared) {
    const id = randomUUID();
    try {
      await put(id, 'original', original, 'image/' + prepared.format);
      await put(id, 'preview.jpg', prepared.preview, 'image/jpeg');
    } catch (error) {
      await remove(id).catch(() => console.error('An incomplete image upload needs cleanup.'));
      throw error;
    }
    return id;
  }
  return { put, get, write, remove, close: () => client.destroy() };
}
