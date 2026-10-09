// Paste / drop / upload -> Blob (ADR-001 §6 inputs). Validation of size and decodability happens in
// acquireFromBlob(); here we only pick the first image-like file.

const IMAGE_TYPE_RE = /^image\//i;

function firstImageFile(list) {
  for (const f of list ?? []) {
    const file = typeof f.getAsFile === 'function' ? (f.kind === 'file' ? f.getAsFile() : null) : f;
    if (file && (IMAGE_TYPE_RE.test(file.type) || file.type === '')) return file;
  }
  return null;
}

/**
 * @param {{dropZone:HTMLElement, uploadInput:HTMLInputElement, onBlob:(blob:Blob, method:'upload'|'paste'|'drop')=>void, doc?:Document}} opts
 * @returns {() => void} cleanup
 */
export function wireInputs({ dropZone, uploadInput, onBlob, doc = document }) {
  const onUpload = () => {
    const file = firstImageFile(uploadInput.files);
    uploadInput.value = ''; // allow choosing the same file again
    if (file) onBlob(file, 'upload');
  };

  const onPaste = (e) => {
    const file = firstImageFile(e.clipboardData?.items) ?? firstImageFile(e.clipboardData?.files);
    if (!file) return; // plain text paste keeps working in inputs
    e.preventDefault();
    onBlob(file, 'paste');
  };

  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('is-dragover');
  };
  const onDragLeave = () => dropZone.classList.remove('is-dragover');
  const onDrop = (e) => {
    dropZone.classList.remove('is-dragover');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const file = firstImageFile(e.dataTransfer.files);
    if (file) onBlob(file, 'drop');
  };
  // Never let a dropped file navigate the panel away.
  const swallow = (e) => { if (hasFiles(e)) e.preventDefault(); };

  uploadInput.addEventListener('change', onUpload);
  doc.addEventListener('paste', onPaste);
  dropZone.addEventListener('dragover', onDragOver);
  dropZone.addEventListener('dragleave', onDragLeave);
  doc.addEventListener('dragover', swallow);
  doc.addEventListener('drop', onDrop);

  return () => {
    uploadInput.removeEventListener('change', onUpload);
    doc.removeEventListener('paste', onPaste);
    dropZone.removeEventListener('dragover', onDragOver);
    dropZone.removeEventListener('dragleave', onDragLeave);
    doc.removeEventListener('dragover', swallow);
    doc.removeEventListener('drop', onDrop);
  };
}
