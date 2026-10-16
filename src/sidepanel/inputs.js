// Image input (UX spec §5): drop anywhere in Home, paste (image -> scan, text -> cert field), Choose image.
// Size/decode validation happens in acquireFromBlob(); here we only route files and classify bad drops.

/** 'image' | 'other' for a File (an empty type is tried as an image; decoding decides). */
export function classifyFile(file) {
  if (!file) return 'other';
  if (file.type === '' || /^image\//i.test(file.type)) return 'image';
  return 'other';
}

const isTextField = (el) => Boolean(el && (el.matches?.('input[type="text"], input:not([type]), textarea') || el.isContentEditable));

/**
 * @param {{doc:Document, home:HTMLElement, fileInput:HTMLInputElement, certInput:HTMLInputElement, dropTitle:HTMLElement,
 *   texts:{idle:string, active:string}, isHomeActive:()=>boolean,
 *   onFile:(file:File, method:'upload'|'paste'|'drop')=>void, onError:(code:'file-type'|'dropped-link')=>void}} o
 * @returns {{clearDrag:()=>void, dispose:()=>void}}
 */
export function wireInputs({ doc, home, fileInput, certInput, dropTitle, texts, isHomeActive, onFile, onError }) {
  const route = (file, method) => {
    if (classifyFile(file) === 'image') onFile(file, method);
    else onError('file-type');
  };

  const onUpload = () => {
    const file = fileInput.files?.[0] ?? null;
    fileInput.value = ''; // allow choosing the same file again
    if (file) route(file, 'upload');
  };

  const onPaste = (e) => {
    if (!isHomeActive()) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const fileItem = items.find((i) => i.kind === 'file');
    if (fileItem) {
      const file = fileItem.getAsFile();
      e.preventDefault(); // an image wins even when focus is in the cert field
      route(file, 'paste');
      return;
    }
    if (isTextField(doc.activeElement)) return; // normal text paste
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.trim()) return;
    e.preventDefault();
    certInput.value = text.trim().slice(0, 64);
    certInput.focus();
    certInput.dispatchEvent(new Event('input', { bubbles: true }));
  };

  let dragging = false;
  const setDrag = (on) => {
    dragging = on;
    doc.body.classList.toggle('is-dragover', on);
    dropTitle.textContent = on ? texts.active : texts.idle;
  };
  const isDrag = (e) => [...(e.dataTransfer?.types ?? [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/html');
  const onDragEnter = (e) => {
    if (!isHomeActive() || !isDrag(e)) return;
    e.preventDefault();
    setDrag(true);
  };
  const onDragOver = (e) => {
    if (!isHomeActive() || !isDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDrag(true);
  };
  const onDragLeave = (e) => {
    if (!home.contains(e.relatedTarget)) setDrag(false);
  };
  const onDrop = (e) => {
    setDrag(false);
    if (!isHomeActive()) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) { route(file, 'drop'); return; }
    const types = [...(e.dataTransfer?.types ?? [])];
    if (types.includes('text/uri-list') || types.includes('text/html')) onError('dropped-link');
  };
  // Never let a drop outside Home (e.g. in Settings) navigate the panel away.
  const swallow = (e) => { if (isDrag(e)) e.preventDefault(); };
  const onDragEnd = () => setDrag(false);

  fileInput.addEventListener('change', onUpload);
  doc.addEventListener('paste', onPaste);
  home.addEventListener('dragenter', onDragEnter);
  home.addEventListener('dragover', onDragOver);
  home.addEventListener('dragleave', onDragLeave);
  home.addEventListener('drop', onDrop);
  doc.addEventListener('dragover', swallow);
  doc.addEventListener('drop', swallow);
  doc.addEventListener('dragend', onDragEnd);

  return {
    clearDrag: () => { if (dragging) setDrag(false); },
    get dragging() { return dragging; },
    dispose() {
      fileInput.removeEventListener('change', onUpload);
      doc.removeEventListener('paste', onPaste);
      home.removeEventListener('dragenter', onDragEnter);
      home.removeEventListener('dragover', onDragOver);
      home.removeEventListener('dragleave', onDragLeave);
      home.removeEventListener('drop', onDrop);
      doc.removeEventListener('dragover', swallow);
      doc.removeEventListener('drop', swallow);
      doc.removeEventListener('dragend', onDragEnd);
    },
  };
}
