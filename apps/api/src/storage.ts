import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";
import { ApiError } from "./http.js";

/**
 * Avatar storage behind one function, so the host is a config choice.
 *
 * `local` writes to disk and exists for development. It is refused in
 * production by `env.ts`, because disk does not survive a redeploy and is not
 * shared between instances — the second instance would 404 the first one's
 * uploads.
 *
 * `s3` targets any S3-compatible bucket: AWS, Cloudflare R2, Backblaze B2, MinIO.
 */

const ALLOWED = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

export const MAX_AVATAR_BYTES = 4_000_000;

export async function storeAvatar(bytes: Buffer, mimeType: string): Promise<string> {
  const extension = ALLOWED.get(mimeType);
  if (!extension) throw ApiError.badRequest("unsupported_image", "Use a JPEG, PNG, or WebP image.");
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw ApiError.badRequest("image_too_large", "Images must be under 4 MB.");
  if (!looksLikeImage(bytes, mimeType)) {
    // The declared content type is attacker-controlled; the magic bytes are not.
    throw ApiError.badRequest("unsupported_image", "That file is not a valid image.");
  }

  const key = `avatars/${randomUUID()}${extension}`;
  if (env.STORAGE_DRIVER === "local") return storeLocal(key, bytes);
  return storeS3(key, bytes, mimeType);
}

function looksLikeImage(bytes: Buffer, mimeType: string): boolean {
  if (bytes.byteLength < 12) return false;
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  return false;
}

async function storeLocal(key: string, bytes: Buffer): Promise<string> {
  const path = join(env.STORAGE_LOCAL_DIR, key);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return `${env.STORAGE_PUBLIC_URL ?? `http://localhost:${env.PORT}/uploads`}/${key}`;
}

async function storeS3(key: string, bytes: Buffer, mimeType: string): Promise<string> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  });
  await client.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET!,
    Key: key,
    Body: bytes,
    ContentType: mimeType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return `${env.STORAGE_PUBLIC_URL ?? `${env.S3_ENDPOINT}/${env.S3_BUCKET}`}/${key}`;
}

export function extensionFor(filename: string): string {
  return extname(filename).toLowerCase();
}
