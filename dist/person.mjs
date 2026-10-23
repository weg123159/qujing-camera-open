/** Local COCO-SSD person detection. Pixels are never sent to a server. */
const PERSON_ASSETS = new URL('./assets/vendor/person/', import.meta.url);
const MODEL_URL = new URL('model/model.json', PERSON_ASSETS).href;
const MAX_SAMPLE_SIDE = 640;
const MIN_PERSON_SCORE = 0.4;
let mainModelPromise = null;
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mediaSize(media) {
  return {
    width: media?.videoWidth || media?.naturalWidth || media?.width || 0,
    height: media?.videoHeight || media?.naturalHeight || media?.height || 0,
  };
}

/** Convert only genuine person predictions; the bottom-center is a foot proxy. */
export function normalizePersonDetections(predictions, {
  width, height, sourceWidth = width, sourceHeight = height, mirrored = false,
  minScore = MIN_PERSON_SCORE,
} = {}) {
  const empty = {
    kind: 'person', point: null, box: null, sourceWidth, sourceHeight,
    mirrored, faceCount: 0, personCount: 0, confidence: null, candidates: [],
  };
  if (![width, height, sourceWidth, sourceHeight].every((value) => Number.isFinite(value) && value > 0)) return empty;
  const people = (Array.isArray(predictions) ? predictions : []).filter((prediction) => {
    const box = prediction?.bbox;
    return prediction?.class === 'person' && Number.isFinite(prediction.score) && prediction.score >= minScore
      && Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
  });
  if (!people.length) return empty;
  // Keep accepted candidates so the camera can select the same geometric
  // subject across frames. Still-image callers retain the largest-box default.
  const candidates = people.map((person) => {
    const [x, y, w, h] = person.bbox;
    const box = { x: x / width, y: y / height, width: w / width, height: h / height };
    return { box, point: { x: box.x + box.width / 2, y: box.y + box.height }, confidence: person.score };
  });
  const selected = candidates.reduce((largest, candidate) => (
    candidate.box.width * candidate.box.height > largest.box.width * largest.box.height ? candidate : largest
  ));
  return {
    ...empty,
    ...selected,
    personCount: people.length,
    candidates,
  };
}

async function loadMainModel() {
  if (!mainModelPromise) {
    mainModelPromise = (async () => {
      await import(new URL('tf.min.js', PERSON_ASSETS).href);
      await import(new URL('coco-ssd.min.js', PERSON_ASSETS).href);
      const tf = globalThis.tf;
      const coco = globalThis.cocoSsd;
      if (!tf || !coco) throw failure('PersonModelUnavailable', '本地人物识别未能加载。');
      await tf.setBackend('cpu');
      await tf.ready();
      const model = await coco.load({ base: 'lite_mobilenet_v2', modelUrl: MODEL_URL });
      return { tf, model };
    })().catch((error) => {
      mainModelPromise = null;
      throw error;
    });
  }
  return mainModelPromise;
}

export class PersonDetector {
  constructor() {
    this.execution = null;
    this._worker = null;
    this._pending = new Map();
    this._nextId = 0;
    this._generation = 0;
    this._disposed = false;
    this._loaded = false;
    this._loadPromise = null;
    this._queue = Promise.resolve();
    this._main = null;
    this._canvas = null;
    this._context = null;
  }

  _createWorker() {
    return new Worker(new URL('worker.js', PERSON_ASSETS), { name: 'qujing-person-detector' });
  }

  _startWorker() {
    if (typeof Worker === 'undefined') throw failure('WorkerUnavailable', '当前浏览器不支持后台识别。');
    try { this._worker = this._createWorker(); }
    catch { throw failure('WorkerUnavailable', '当前浏览器未能启动后台识别。'); }
    const worker = this._worker;
    worker.addEventListener('message', ({ data }) => {
      if (this._worker !== worker) return;
      const pending = this._pending.get(data?.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(failure(data.code || 'PersonModelUnavailable', '人物识别暂时不可用，请重试。'));
    });
    worker.addEventListener('error', (event) => {
      if (this._worker !== worker) return;
      event.preventDefault?.();
      this._rejectPending(failure('WorkerUnavailable', '后台识别被浏览器中断。'));
      this._worker?.terminate();
      this._worker = null;
      this._loaded = false;
      this._loadPromise = null;
    });
  }

  _rejectPending(error) {
    for (const request of this._pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this._pending.clear();
  }

  _request(type, payload = {}, transfer = [], timeoutMs = 120000) {
    if (!this._worker) return Promise.reject(failure('WorkerUnavailable', '后台识别尚未就绪。'));
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(failure('PersonTimeout', '人物识别等待超时，请检查连接后重试。'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this._worker.postMessage({ id, type, ...payload }, transfer); }
      catch {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(failure('WorkerUnavailable', '无法向后台识别传递画面。'));
      }
    });
  }

  /** Downloads model resources only when explicitly requested by the caller. */
  async load() {
    if (this._disposed) throw failure('Cancelled', '人物识别已关闭。');
    if (this._loaded) return { execution: this.execution };
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      try {
        this._startWorker();
        await this._request('load');
        this.execution = 'worker-cpu';
      } catch (error) {
        this._worker?.terminate();
        this._worker = null;
        if (this._disposed) throw failure('Cancelled', '人物识别已关闭。');
        // A model/network error is not retried in a second runtime. Only an
        // unavailable Worker switches to the slower main-thread CPU path.
        if (error.code !== 'WorkerUnavailable') throw error;
        this._main = await loadMainModel();
        this.execution = 'main-cpu';
      }
      if (this._disposed) throw failure('Cancelled', '人物识别已关闭。');
      this._loaded = true;
      return { execution: this.execution };
    })();
    try { return await this._loadPromise; }
    catch (error) { this._loadPromise = null; throw error; }
  }

  _capture(media) {
    const { width: sourceWidth, height: sourceHeight } = mediaSize(media);
    if (!sourceWidth || !sourceHeight) throw failure('InvalidImage', '画面尚未加载完成。');
    const scale = Math.min(1, MAX_SAMPLE_SIDE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (!this._canvas) this._canvas = document.createElement('canvas');
    // Reassigning either dimension reallocates/clears the canvas, even when
    // unchanged. Reuse its backing store for ordinary video frames.
    if (this._canvas.width !== width) this._canvas.width = width;
    if (this._canvas.height !== height) this._canvas.height = height;
    const context = this._context || (this._context = this._canvas.getContext('2d', { willReadFrequently: true }));
    if (!context) throw failure('ImageReadError', '无法读取当前画面。');
    const capturedAtMs = nowMs();
    context.drawImage(media, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return { pixels, width, height, sourceWidth, sourceHeight, capturedAtMs };
  }

  async _predictMain(frame) {
    const { tf, model } = this._main;
    const pixels = new Uint8Array(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
    const tensor = tf.browser.fromPixels({ data: pixels, width: frame.width, height: frame.height }, 3);
    try { return await model.detect(tensor, 20, MIN_PERSON_SCORE); }
    finally { tensor.dispose(); }
  }

  /** Serial inference; result boxes remain normalized against the original view. */
  detect(media, { mirrored = false, isCancelled = () => false } = {}) {
    const generation = this._generation;
    const cancelled = () => this._disposed || generation !== this._generation || isCancelled();
    const job = this._queue.then(async () => {
      if (cancelled()) throw failure('Cancelled', '已取消旧画面的识别。');
      await this.load();
      if (cancelled()) throw failure('Cancelled', '已取消旧画面的识别。');
      const startedAtMs = nowMs();
      const frame = this._capture(media);
      const capturedAtMs = Number.isFinite(frame.capturedAtMs) ? frame.capturedAtMs : startedAtMs;
      const predictions = this.execution === 'worker-cpu'
        ? await this._request('detect', {
          pixels: frame.pixels.buffer, width: frame.width, height: frame.height,
          minScore: MIN_PERSON_SCORE,
        }, [frame.pixels.buffer], 45000)
        : await this._predictMain(frame);
      if (cancelled()) throw failure('Cancelled', '已取消旧画面的识别。');
      return {
        ...normalizePersonDetections(predictions, { ...frame, mirrored }),
        capturedAtMs,
        inferenceDurationMs: Math.max(0, nowMs() - capturedAtMs),
      };
    });
    this._queue = job.catch(() => {});
    return job;
  }

  /** Invalidates queued/in-flight results while keeping the downloaded model. */
  invalidate() { ++this._generation; }

  dispose() {
    this._disposed = true;
    ++this._generation;
    this._rejectPending(failure('Cancelled', '人物识别已关闭。'));
    this._worker?.terminate();
    this._worker = null;
    this._canvas = null;
    this._context = null;
    this._loaded = false;
  }
}
