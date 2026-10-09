// Test helpers: synthetic OcrPage objects shaped like src/pipeline/ocr.js output.

/**
 * Build an OcrPage from lines of text. Every word gets the same confidence unless a per-line
 * confidence array is supplied.
 * @param {string[]} lines
 * @param {{conf?:number|number[], pass?:'text'|'digits', rotation?:number}} [opts]
 */
export function ocrPage(lines, { conf = 88, pass = 'text', rotation = 0 } = {}) {
  const words = [];
  lines.forEach((line, lineId) => {
    const c = Array.isArray(conf) ? conf[lineId] : conf;
    let x = 0;
    for (const w of line.split(/\s+/).filter(Boolean)) {
      words.push({ text: w, confidence: c, bbox: { x0: x, y0: lineId * 40, x1: x + w.length * 20, y1: lineId * 40 + 30 }, lineText: line, lineId });
      x += w.length * 20 + 12;
    }
  });
  const mean = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
  return { text: lines.join('\n'), confidence: mean, pass, rotation, words };
}

export const digitsPage = (text, conf = 88) => ocrPage([text], { conf, pass: 'digits' });

export const settings = (over = {}) => ({ v: 1, autoOpen: true, openInBackground: false, saveHistory: true, ...over });
