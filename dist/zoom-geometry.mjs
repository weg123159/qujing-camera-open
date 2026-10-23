import { getCoverCrop } from './guide.mjs';

const positive = value => Number.isFinite(value) && value > 0;
const invisible = () => ({ x: NaN, y: NaN, visible: false });

/** Pixel crop matching a centered CSS object-fit:cover followed by scale(zoom). */
export function getZoomCrop(sourceWidth, sourceHeight, viewAspect, zoom = 1) {
  if (!Number.isFinite(zoom) || zoom < 1) throw new RangeError('Digital crop zoom must be finite and at least 1.');
  const base = getCoverCrop(sourceWidth, sourceHeight, viewAspect, 1);
  const sw = base.sw / zoom, sh = base.sh / zoom;
  return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh };
}

/** Same exact crop for overlay coordinates, photo preview, freeze and export. */
export function pointToCropView(point, sourceWidth, sourceHeight, crop, mirrored = false) {
  if (!point || ![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
    || ![sourceWidth, sourceHeight].every(positive) || !crop || ![crop.sx, crop.sy, crop.sw, crop.sh].every(Number.isFinite)
    || crop.sw <= 0 || crop.sh <= 0) return invisible();
  const rawX = (point.x * sourceWidth - crop.sx) / crop.sw;
  const x = mirrored ? 1 - rawX : rawX;
  const y = (point.y * sourceHeight - crop.sy) / crop.sh;
  return { x, y, visible: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}
