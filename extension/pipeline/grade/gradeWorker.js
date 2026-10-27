// Module worker for the grade check: keeps the last photo per side ('front' / 'back') so a hand-placed outline can be
// measured again without sending the pixels a second time. Messages:
//   {id, key, image?:{buffer, width, height}, quad?}  -> {id, ok:true, result} | {id, ok:false, error}
//   {forget:key}                                       -> drops that photo
import { analyzeCard } from './analyze.js';

const photos = new Map();

self.onmessage = (e) => {
  const msg = e.data ?? {};
  if (typeof msg.forget === 'string') { photos.delete(msg.forget); return; }
  const { id, key, image, quad } = msg;
  try {
    if (image) photos.set(key, { data: new Uint8ClampedArray(image.buffer), width: image.width, height: image.height });
    const img = photos.get(key);
    if (!img) throw new Error('no photo');
    const result = analyzeCard(img, { quad });
    self.postMessage({ id, ok: true, result }, result.card ? [result.card.data.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err).slice(0, 200) });
  }
};
