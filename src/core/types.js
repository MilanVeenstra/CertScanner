// Shared contract (ADR-001 §5–§7). JSDoc typedefs only; this module exports nothing at runtime.

/** @typedef {'psa'|'cgc-comics'|'cgc-cards'|'bgs'} Grader */

/** @typedef {'data-url'|'extension-fetch'|'page-fetch'|'capture'|'upload'|'paste'|'drop'} AcquireMethod */

/**
 * @typedef {'restricted'|'not-found'|'too-large'|'fetch-failed'|'capture-failed'|'tab-changed'
 *   |'invalid-image'|'engine-failed'|'timeout'|'aborted'} ScanErrorCode
 */

/**
 * @typedef {{method:AcquireMethod, resolution:'full'|'screen', width:number, height:number,
 *   origin:string|null, canRequestSharper:boolean}} ImageInfo
 */

/**
 * @typedef {{ok:true, bitmap:ImageBitmap, blob:Blob, info:ImageInfo}
 *   | {ok:false, reason:ScanErrorCode, origin:string|null, canRequestSharper:boolean}} AcquireResult
 */

/**
 * One OCR read of an image or crop. `pass` is additive to ADR §6 (identifies independent reads):
 * 'text' = sparse text pass, 'digits' = whitelisted digits pass.
 * @typedef {{text:string, confidence:number, pass?:'text'|'digits', rotation?:number,
 *   words:{text:string, confidence:number, bbox:{x0:number,y0:number,x1:number,y1:number}, lineText:string, lineId?:number}[]}} OcrPage
 */

/** @typedef {{format:string, text:string, engine:'native'|'zxing'}} BarcodeRead */

/**
 * @typedef {{grader:Grader|null, graderOptions:Grader[], number:string, confidence:number,
 *   source:'qr-url'|'barcode'|'ocr'|'manual', evidence:string[]}} CertCandidate
 * evidence codes: 'len:8','kw:GEM MT','pass:text','pass:digits','fixup','cert-label','dash-form',
 *   'qr-host:www.cgccomics.com','qr-path-unmatched','qr-untrusted:evil.example','barcode:Code128','conflict',
 *   A20: 'incomplete' (too short for the label's grader), 'label-pass', 'second-opinion', 'near-dup:<number>',
 *   'completes:<number>'
 */

/** @typedef {{code:'qr-untrusted-host'|'low-resolution'|'ocr-unavailable', detail?:string}} ScanWarning */

/**
 * @typedef {{jobId:string|null, status:'auto-open'|'confirm'|'none'|'error', candidates:CertCandidate[],
 *   imageInfo:ImageInfo|null, warnings:ScanWarning[], error?:{code:ScanErrorCode, origin?:string},
 *   timings:{acquireMs:number, preprocessMs:number, barcodeMs:number, ocrInitMs:number, ocrMs:number, totalMs:number},
 *   labelText?:string[], passes?:ScanPass[]}} ScanResult
 * passes (A20): one entry per recognize call, in memory only (never stored); exported only by the user's
 * "This went wrong" click.
 */

/**
 * @typedef {{pass:'text'|'digits', variant:string|null, label:boolean, rotation:number, ms:number|null,
 *   confidence:number, text:string}} ScanPass
 */

/** @typedef {{stage:'acquire'|'decode'|'barcode'|'ocr-init'|'ocr'|'parse', fraction?:number}} ScanProgress */

/**
 * A7: no frameUrl; pageUrl is origin + path only (no query/hash).
 * srcIssue (optional, additive in S6): why srcUrl is null - 'too-long' (oversized data: URL) or 'unsupported' scheme.
 * @typedef {{v:1, id:string, createdAt:number, source:'contextMenu', srcUrl:string|null, pageUrl:string,
 *   frameId:number, tabId:number, windowId:number, mediaType:'image',
 *   srcIssue?:'too-long'|'unsupported'}} ScanJob
 */

/** @typedef {{v:number, autoOpen:boolean, openInBackground:boolean, saveHistory:boolean, scanOnToolbarClick:boolean}} Settings */

/**
 * A9 page job: scan the images of the page in tab `tabId` (main frame). No srcUrl, no mediaType.
 * @typedef {{v:1, id:string, createdAt:number, kind:'page', source:'action'|'command'|'panel', srcUrl:null,
 *   pageUrl:string, frameId:0, tabId:number, windowId:number}} PageScanJob
 */

/**
 * @typedef {{grader:Grader, number:string, at:number, source:'qr-url'|'barcode'|'ocr'|'manual',
 *   pageHost:string|null}} HistoryEntry
 */

export {};
