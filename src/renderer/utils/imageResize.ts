/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shrinks a photo picked by the owner before it is sent to the main process: at most
 * 1280 px on the longer side, JPEG quality 0.85. A phone photo of 4-8 MB becomes ~150-300 KB,
 * which keeps the photo folder, backups and the catalogue fast.
 */

export const MAX_PHOTO_SIDE = 1280;

export async function resizeImageFile(file: File, maxSide: number = MAX_PHOTO_SIDE): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('აირჩიეთ JPEG, PNG ან WebP ფორმატის ფოტო');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('ფოტოს წაკითხვა ვერ მოხერხდა'));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ფოტოს დამუშავება ვერ მოხერხდა');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** URL to display a product photo (new rows carry `url`, legacy rows a data: URL). */
export function photoSrc(img: { url?: string; file_path: string } | undefined): string | undefined {
  return img ? img.url || img.file_path : undefined;
}
