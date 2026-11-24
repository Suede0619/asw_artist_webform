import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { MAX_BYTES, MAX_PIXELS, MIN_EDGE } from '../shared/intake.mjs';
import { IntakeError } from './errors.mjs';

export const MAX_ASSETS_PER_APPLICATION = 60;

function allowedSignature(buffer) {
  return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP');
}

export function assetDirectory(directory, id) {
  return join(directory, 'media', id);
}

export function mediaPath(directory, id, original = false) {
  return join(assetDirectory(directory, id), original ? 'original' : 'preview.jpg');
}

export async function prepareImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new IntakeError(400, 'Choose an image first.');
  if (buffer.length > MAX_BYTES) throw new IntakeError(413, 'Choose an image no larger than 12 MB.');
  if (!allowedSignature(buffer)) {
    throw new IntakeError(415, 'Choose a JPEG, PNG or WebP image. If you have an iPhone HEIC photo, export it as JPEG first.');
  }

  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning', sequentialRead: true });
    const metadata = await pipeline.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) {
      throw new IntakeError(415, 'Choose a single still JPEG, PNG or WebP image.');
    }
    const { width, height } = metadata.autoOrient || metadata;
    if (Math.max(width, height) < MIN_EDGE) {
      throw new IntakeError(422, 'This image is ' + width + ' by ' + height +
        ' pixels. Choose a photo with at least 1,080 pixels on its longest side.');
    }
    const preview = await pipeline.rotate().resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    return { format: metadata.format, width, height, bytes: buffer.length, preview };
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    if (/pixel limit/i.test(error.message)) throw new IntakeError(413, 'Choose a photo of 52 megapixels or less.');
    throw new IntakeError(422, 'We couldn’t read this image. Export a fresh JPEG, PNG or WebP and try again.');
  }
}

export async function writeAsset(directory, original, prepared) {
  const id = randomUUID();
  const target = assetDirectory(directory, id);
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    await writeFile(mediaPath(directory, id, true), original, { flag: 'wx', mode: 0o600, flush: true });
    await writeFile(mediaPath(directory, id), prepared.preview, { flag: 'wx', mode: 0o600, flush: true });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return id;
}
