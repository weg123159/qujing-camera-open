/**
 * Narrow bridge for the packaged, network-disabled Android host.
 * A browser page never probes or invokes the native bridge on another origin.
 * Native success is acknowledged only by its correlated completion event.
 */
export const MAX_NATIVE_PHOTO_BYTES = 12 * 1024 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const ORIGIN = 'https://appassets.androidplatform.net';
const SAVE_EVENT = 'qujing-native-save';
let nextRequest = 0;

function packagedLocation(scope) {
  try { return scope.location?.origin === ORIGIN && scope.location?.pathname?.startsWith('/www/') === true; }
  catch { return false; }
}

export function detectNativeHost(scope = globalThis) {
  try {
    if (!packagedLocation(scope)) return null;
    const bridge = scope.QujingNative;
    if (typeof bridge?.getInfo !== 'function' || typeof bridge?.savePhoto !== 'function') return null;
    const raw = bridge.getInfo();
    if (typeof raw !== 'string' || raw.length > 4096) return null;
    const value = JSON.parse(raw);
    if (!value || value.platform !== 'android' || typeof value.version !== 'string' || !value.version
      || value.version.length > 64 || value.bundledOffline !== true || value.networkPermission !== false) return null;
    const info = Object.freeze({
      platform: 'android', version: value.version, bundledOffline: true,
      networkPermission: false, savePhoto: true,
    });
    return Object.freeze({ bridge, info });
  } catch { return null; }
}

function encodeJpeg(blob, { scope, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Photo save cancelled.')); return; }
    const Reader = scope.FileReader;
    if (typeof Reader !== 'function') { reject(new Error('FileReader unavailable.')); return; }
    const reader = new Reader();
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', cancel);
      reader.onload = reader.onerror = reader.onabort = null;
      error ? reject(error) : resolve(value);
    };
    const cancel = () => {
      try { reader.abort(); } catch { /* Already finished. */ }
      finish(new Error('Photo save cancelled.'));
    };
    reader.onload = () => finish(null, reader.result);
    reader.onerror = () => finish(new Error('Photo encoding failed.'));
    reader.onabort = () => finish(new Error('Photo save cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    try { reader.readAsDataURL(blob); }
    catch { finish(new Error('Photo encoding failed.')); }
  });
}

function validDataUrl(value, size) {
  if (typeof value !== 'string' || !value.startsWith(JPEG_PREFIX)) return false;
  const data = value.slice(JPEG_PREFIX.length);
  const padding = (3 - size % 3) % 3;
  // readAsDataURL uses canonical Base64; validate bound before the expression.
  return data.length === Math.ceil(size / 3) * 4
    && /^[A-Za-z0-9+/]+={0,2}$/.test(data)
    && data.length - data.replace(/=+$/, '').length === padding
    && data.length <= Math.ceil(MAX_NATIVE_PHOTO_BYTES / 3) * 4;
}

function requestId(scope) {
  let random = '';
  try { random = scope.crypto?.randomUUID?.() || ''; } catch { /* Counter remains unique in this page. */ }
  return `qj-${Date.now().toString(36)}-${++nextRequest}${random ? `-${random}` : ''}`;
}

/**
 * save(blob) resolves {status, message, requestId?}; it never claims success
 * merely because savePhoto() returned. The system picker has no time limit.
 * encodeBlob is an optional test dependency; production uses FileReader.
 */
export function createNativePhotoSaver({
  scope = globalThis, host = detectNativeHost(scope), onStatus = () => {}, encodeBlob = encodeJpeg,
} = {}) {
  let active = null;
  let disposed = false;
  const defaults = {
    saved: '照片已保存。', cancelled: '已取消保存，照片预览仍保留。',
    error: '照片未保存，请重试。', busy: '正在保存上一张照片，请先完成系统保存操作。',
  };
  const notify = (value) => {
    try { onStatus(value); } catch { /* A UI callback must not strand the save. */ }
  };
  const finish = (job, status, message) => {
    if (active !== job) return;
    active = null;
    job.abort.abort();
    const result = { status, requestId: job.id, message: message || defaults[status] };
    notify(result);
    job.resolve(result);
  };
  const handleResult = (event) => {
    const detail = event?.detail, job = active;
    if (!job || job.phase !== 'native' || detail?.requestId !== job.id
      || !['saved', 'cancelled', 'error'].includes(detail.status)) return;
    const message = typeof detail.message === 'string' && detail.message.trim()
      ? detail.message.trim().slice(0,320) : defaults[detail.status];
    finish(job, detail.status, message);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (active) finish(active, 'cancelled', '页面已离开，已结束本次保存等待。');
    scope.removeEventListener?.(SAVE_EVENT, handleResult);
    scope.removeEventListener?.('pagehide', dispose);
  };
  scope.addEventListener?.(SAVE_EVENT, handleResult);
  scope.addEventListener?.('pagehide', dispose);

  return Object.freeze({
    get pending() { return active !== null; },
    dispose,
    save(blob) {
      if (active) return Promise.resolve({ status: 'busy', message: defaults.busy });
      const fail = (message) => {
        const result = { status: 'error', message };
        notify(result);
        return Promise.resolve(result);
      };
      if (disposed) return fail('当前页面的保存通道已关闭，请重新打开应用。');
      if (!packagedLocation(scope) || !host?.bridge || typeof host.bridge.savePhoto !== 'function') return fail('当前环境没有原生照片保存功能。');
      const BlobType = scope.Blob || globalThis.Blob;
      if (typeof BlobType !== 'function' || !(blob instanceof BlobType) || blob.type !== 'image/jpeg'
        || blob.size <= 0 || blob.size > MAX_NATIVE_PHOTO_BYTES) return fail('只能保存不超过 12 MB 的 JPEG 照片。');
      const Abort = scope.AbortController || globalThis.AbortController;
      if (typeof Abort !== 'function') return fail('当前环境无法准备照片保存，请更新系统 WebView 后重试。');
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const job = { id: requestId(scope), resolve, abort: new Abort(), phase: 'encoding' };
      active = job;
      notify({ status: 'pending', requestId: job.id, message: '正在准备照片，请在系统窗口中选择保存位置。' });
      Promise.resolve().then(() => encodeBlob(blob, { scope, signal: job.abort.signal })).then((dataUrl) => {
        if (active !== job || disposed) return;
        if (!packagedLocation(scope)) throw new Error('Native origin changed.');
        if (!validDataUrl(dataUrl, blob.size)) throw new Error('Invalid JPEG encoding.');
        job.phase = 'native';
        host.bridge.savePhoto(dataUrl, job.id);
      }).catch(() => {
        if (active === job) finish(job, 'error', '照片未能交给系统保存，预览仍保留，请重试。');
      });
      return promise;
    },
  });
}
