import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPhotoFile, ocrInputSize, MAX_OCR_PIXELS, PHOTO_MAX_BYTES } from './offlineOcr.ts';

test('ocrInputSize: camera regions are sent unchanged, large photos are scaled down proportionally', () => {
  assert.deepEqual(ocrInputSize(1690, 565), { width: 1690, height: 565 }, '1920x1080 frame region');
  assert.deepEqual(ocrInputSize(1127, 377), { width: 1127, height: 377 }, '1280x720 frame region');
  const photo = ocrInputSize(4000, 3000); // 12-megapixel phone photo
  assert.ok(photo.width * photo.height <= MAX_OCR_PIXELS, `${photo.width}x${photo.height}`);
  assert.ok(Math.abs(photo.width / photo.height - 4 / 3) < 0.01, 'aspect ratio kept');
});

test('photo import accepts only real JPG/PNG files within the size limit', async () => {
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], 'a.png', { type: 'image/png' });
  const jpg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])], 'a.jpg', { type: 'image/jpeg' });
  assert.equal(await checkPhotoFile(png), null);
  assert.equal(await checkPhotoFile(jpg), null);
  const renamed = new File([new TextEncoder().encode('<svg onload=alert(1)>')], 'x.png', { type: 'image/png' });
  assert.match(String(await checkPhotoFile(renamed)), /არ არის/);
  const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], 'a.gif', { type: 'image/gif' });
  assert.match(String(await checkPhotoFile(gif)), /JPG ან PNG/);
  const huge = new File([new Uint8Array(PHOTO_MAX_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' });
  assert.match(String(await checkPhotoFile(huge)), /15 MB/);
});
