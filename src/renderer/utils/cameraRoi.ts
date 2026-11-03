/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The green frame of the camera dialog and the camera pixels it covers. The frame is drawn at
 * fixed fractions of the preview box; the video fills that box with object-fit: cover (part of
 * the picture is cut off at the sides or at the top and bottom). frameInVideo() maps the frame
 * through the same cover transform, so the pixels recognised are exactly the ones inside the
 * frame on screen, at any window size and camera aspect ratio.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Frame position as fractions of the preview box. */
export const OCR_FRAME = { left: 0.06, top: 0.14, width: 0.88, height: 0.72 };

/** The frame's rectangle in video pixels for a video shown with object-fit: cover. */
export function frameInVideo(
  box: { width: number; height: number },
  video: { width: number; height: number },
  frame = OCR_FRAME,
): Rect {
  const scale = Math.max(box.width / video.width, box.height / video.height);
  const offsetX = (box.width - video.width * scale) / 2;
  const offsetY = (box.height - video.height * scale) / 2;
  const x0 = Math.max(0, (frame.left * box.width - offsetX) / scale);
  const y0 = Math.max(0, (frame.top * box.height - offsetY) / scale);
  const x1 = Math.min(video.width, ((frame.left + frame.width) * box.width - offsetX) / scale);
  const y1 = Math.min(video.height, ((frame.top + frame.height) * box.height - offsetY) / scale);
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}
