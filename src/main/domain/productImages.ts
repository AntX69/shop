/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Product photo storage. Photos are files in <data>/images (not base64 inside SQLite), named
 * by the app (random names, never names chosen by the renderer). The renderer receives a URL:
 * the desktop app serves them through the storepos-img:// protocol, the dev server over HTTP.
 * Older databases stored photos as data: URLs in product_images.file_path; they are moved to
 * files once, at start-up, without losing any photo.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { imagesDirectoryFor } from '../db/database.ts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const SAFE_IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const MIME_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export function imageUrlPrefix(): string {
  return process.env.STOREPOS_IMAGE_URL_PREFIX || 'storepos-img://photo/';
}

/** URL the renderer uses for a stored photo reference. */
export function imageUrl(filePath: string): string {
  if (filePath.startsWith('data:')) return filePath; // legacy row not migrated yet
  return imageUrlPrefix() + encodeURIComponent(path.basename(filePath));
}

function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } {
  const m = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new Error('სურათის ფორმატი არასწორია (საჭიროა JPEG, PNG ან WebP)');
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) throw new Error('სურათის ფორმატი არ არის მხარდაჭერილი (საჭიროა JPEG, PNG ან WebP)');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) throw new Error('სურათი ცარიელია');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('სურათი ძალიან დიდია (მაქსიმუმ 8 MB)');
  return { bytes, ext };
}

/**
 * Accepts a photo from the renderer (a data: URL) or a file already inside the photo folder,
 * and returns the stored file name. Anything else (paths elsewhere on disk) is refused.
 */
export function storeProductImage(db: DatabaseSync, input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('სურათი სავალდებულოა');
  const value = input.trim();
  const dir = imagesDirectoryFor(db);
  if (value.startsWith('data:')) {
    const { bytes, ext } = decodeDataUrl(value);
    const name = `p_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    const target = path.join(dir, name);
    fs.writeFileSync(`${target}.partial`, bytes);
    fs.renameSync(`${target}.partial`, target);
    return name;
  }
  const name = path.basename(value);
  const resolved = path.resolve(path.isAbsolute(value) ? value : path.join(dir, value));
  if (path.dirname(resolved) !== path.resolve(dir) || !SAFE_IMAGE_FILE.test(name) || !fs.existsSync(resolved)) {
    throw new Error('სურათი უნდა აიტვირთოს პროგრამიდან (გარე ფაილის მისამართი დაუშვებელია)');
  }
  return name;
}

/** Deletes a photo file when no product_images row refers to it any more. */
export function deleteImageFileIfUnused(db: DatabaseSync, fileName: string): void {
  if (!fileName || fileName.startsWith('data:')) return;
  const name = path.basename(fileName);
  const stillUsed = db.prepare("SELECT 1 FROM product_images WHERE file_path = ? LIMIT 1").get(name);
  if (stillUsed) return;
  try { fs.unlinkSync(path.join(imagesDirectoryFor(db), name)); } catch {}
}

/** Moves photos stored as data: URLs into files. Safe to run on every start. */
export function migrateInlineImagesToFiles(db: DatabaseSync): number {
  const rows = db.prepare("SELECT id, file_path FROM product_images WHERE file_path LIKE 'data:%'").all() as Array<{ id: number; file_path: string }>;
  let moved = 0;
  for (const row of rows) {
    try {
      const name = storeProductImage(db, row.file_path);
      db.prepare("UPDATE product_images SET file_path = ? WHERE id = ?").run(name, row.id);
      moved++;
    } catch (err) {
      // Keep the inline photo rather than lose it; it is still served as a data: URL.
      console.warn(`[Images] Photo #${row.id} kept inline: ${(err as Error).message}`);
    }
  }
  return moved;
}
