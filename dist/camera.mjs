/**
 * Camera preview and on-device face/person detection.
 * All frame coordinates are normalized against the ORIGINAL media dimensions.
 * The UI owns object-fit cropping and mirrored display transforms.
 * No camera frame or uploaded image is sent to a remote service.
 */
import { PersonDetector } from './person.mjs';

const VENDOR = new URL('./assets/vendor/', import.meta.url);
const FRAME_INTERVAL_MS = 125;
const CPU_FRAME_INTERVAL_MS = 250;
const PERSON_WORKER_INTERVAL_MS = 300;
const PERSON_MAIN_INTERVAL_MS = 900;
const CAMERA_TIMEOUT_MS = 22000;
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

let faceApiCpuPromise = null;

async function loadFaceApiCpu() {
  if (!faceApiCpuPromise) {
    faceApiCpuPromise = (async () => {
      // The pinned UMD bundle also runs as a browser ES module and exposes
      // faceapi on self. The CPU backend uses JavaScript and a 2D canvas only.
      await import(new URL('face-api/face-api.min.js', VENDOR).href);
      const faceapi = globalThis.faceapi;
      if (!faceapi?.tf || !faceapi?.nets?.tinyFaceDetector) throw namedError('DetectionUnsupported', 'CPU face detector is unavailable.');
      await faceapi.tf.setBackend('cpu');
      await faceapi.tf.ready();
      if (faceapi.tf.getBackend() !== 'cpu') throw namedError('DetectionUnsupported', 'CPU backend could not be selected.');
      if (!faceapi.nets.tinyFaceDetector.isLoaded) {
        await faceapi.nets.tinyFaceDetector.loadFromUri(new URL('face-api/weights/', VENDOR).href);
      }
      return faceapi;
    })().catch((error) => {
      faceApiCpuPromise = null;
      throw error;
    });
  }
  return faceApiCpuPromise;
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function cameraError(error) {
  const code = error?.name || 'CameraError';
  const messages = {
    NotAllowedError: '相机权限未开启。请在浏览器的站点设置中允许相机，再重试。',
    PermissionDeniedError: '相机权限未开启。请在浏览器的站点设置中允许相机，再重试。',
    NotFoundError: '没有检测到可用相机。可以先上传照片，或体验示例画面。',
    DevicesNotFoundError: '没有检测到可用相机。可以先上传照片，或体验示例画面。',
    NotReadableError: '相机可能正被其他应用占用。关闭其他相机应用后重试。',
    TrackStartError: '相机可能正被其他应用占用。关闭其他相机应用后重试。',
    OverconstrainedError: '当前相机不支持所需设置。请切换相机或换一个浏览器重试。',
    SecurityError: '浏览器限制了相机访问。请在独立浏览器页面打开并允许相机。',
    CameraTimeout: '等待相机超时。请检查浏览器的权限提示，然后点击开启相机重试。',
    VideoTimeout: '相机未传回画面。请关闭其他相机应用后重试。',
    AbortError: '相机开启被中断，请重试。',
  };
  return { code, message: messages[code] || '暂时无法开启相机。请在独立浏览器页面打开，或先上传照片。' };
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

const unavailableZoom = () => ({
  supported: false, mode: 'unavailable', min: 1, max: 1, step: 1,
  value: 1, pending: false, requested: null, error: null,
});

function readTrackZoom(track) {
  if (!track || track.readyState === 'ended' || typeof track.applyConstraints !== 'function') return unavailableZoom();
  try {
    const range = track.getCapabilities?.().zoom;
    const value = track.getSettings?.().zoom;
    if (!range || ![range.min, range.max, value].every(Number.isFinite)
      || range.min <= 0 || range.max <= range.min || value < range.min || value > range.max) return unavailableZoom();
    return {
      supported: true, mode: 'track', min: range.min, max: range.max,
      step: Number.isFinite(range.step) && range.step > 0 ? range.step : 0,
      value, pending: false, requested: null, error: null,
    };
  } catch { return unavailableZoom(); }
}

const unavailableExposure = (reason = 'not_available') => ({
  supported: false, mode: 'unavailable', unit: 'EV', meteringMode: null,
  min: 0, max: 0, step: 0, value: null, pending: false, requested: null,
  error: null, reason,
});

function readTrackExposure(track) {
  if (!track || track.readyState === 'ended' || typeof track.applyConstraints !== 'function') return unavailableExposure();
  try {
    const range = track.getCapabilities?.().exposureCompensation;
    const settings = track.getSettings?.() || {};
    // W3C defines EV compensation only for automatic metering. Do not silently
    // switch a manual exposure camera, or label an unknown mode as controllable.
    if (!['continuous', 'single-shot'].includes(settings.exposureMode)) {
      return unavailableExposure(settings.exposureMode === 'manual' ? 'manual_exposure' : 'unknown_exposure_mode');
    }
    const value = settings.exposureCompensation;
    if (!range || ![range.min, range.max, value].every(Number.isFinite)
      || range.max <= range.min || value < range.min || value > range.max) return unavailableExposure('missing_range_or_readback');
    return {
      supported: true, mode: 'track', unit: 'EV', meteringMode: settings.exposureMode,
      min: range.min, max: range.max,
      step: Number.isFinite(range.step) && range.step > 0 ? range.step : 0,
      value, pending: false, requested: null, error: null, reason: null,
    };
  } catch { return unavailableExposure('unreadable'); }
}

function clampTrackZoom(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, value));
  const snapped = range.step > 0 ? range.min + Math.round((clamped - range.min) / range.step) * range.step : clamped;
  return Math.max(range.min, Math.min(range.max, Number(snapped.toFixed(8))));
}

function mediaSize(media) {
  return {
    width: media.videoWidth || media.naturalWidth || media.width || 0,
    height: media.videoHeight || media.naturalHeight || media.height || 0,
  };
}

function emptyFrame(width, height, mirrored = false, kind = 'face') {
  return {
    kind, point: null, box: null, sourceWidth: width, sourceHeight: height, mirrored,
    faceCount: 0, personCount: 0, confidence: null, candidates: [], subjectKey: null,
    observationId: null, capturedAtMs: null, expectedIntervalMs: null,
  };
}

function normalizedFrame(result, width, height, mirrored) {
  if (!width || !height) return emptyFrame(width, height, mirrored);
  const faces = (result?.detections || []).filter((face) => {
    const b = face.boundingBox;
    return b && [b.originX, b.originY, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
  });
  if (!faces.length) return emptyFrame(width, height, mirrored);
  const candidates = faces.map((face) => {
    const b = face.boundingBox;
    const box = { x: b.originX / width, y: b.originY / height, width: b.width / width, height: b.height / height };
    const score = face.categories?.find((category) => Number.isFinite(category?.score))?.score;
    return { box, point: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, confidence: Number.isFinite(score) ? score : null };
  });
  const largest = candidates.reduce((best, face) => face.box.width * face.box.height > best.box.width * best.box.height ? face : best);
  return {
    kind: 'face',
    ...largest,
    sourceWidth: width,
    sourceHeight: height,
    mirrored,
    faceCount: faces.length,
    personCount: 0,
    candidates,
  };
}

const validBox = (box) => Boolean(box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
  && box.width > 0 && box.height > 0);

/**
 * Geometric continuity only, not identity recognition or a motion predictor.
 * Keep a nearby overlapping candidate instead of selecting the largest anew.
 * When no candidate matches, emit NO position while briefly waiting to reacquire.
 * Crossings/occlusion can still make two people geometrically indistinguishable.
 */
export class SubjectSelector {
  constructor() { this._serial = 0; this.reset(); }

  reset() {
    this._track = null;
    this._lastSeenAt = -Infinity;
    this._misses = 0;
    this._context = null;
  }

  select(frame, { capturedAtMs = nowMs(), expectedIntervalMs = 300 } = {}) {
    const interval = Number.isFinite(expectedIntervalMs) && expectedIntervalMs > 0 ? expectedIntervalMs : 300;
    const context = `${frame.kind}:${frame.sourceWidth}:${frame.sourceHeight}:${Boolean(frame.mirrored)}`;
    const maxGap = Math.max(1000, Math.min(5000, interval * 3));
    if (this._context !== context || capturedAtMs < this._lastSeenAt || capturedAtMs - this._lastSeenAt > maxGap) this.reset();
    this._context = context;
    const rawCandidates = Array.isArray(frame.candidates) ? frame.candidates : frame.box ? [frame] : [];
    const candidates = rawCandidates.filter((candidate) => validBox(candidate.box));
    const missing = () => ({ ...frame, point: null, box: null, confidence: null, subjectKey: null });
    if (!candidates.length) { ++this._misses; return missing(); }

    let selected = null;
    if (this._track) {
      const previous = this._track.box;
      let best = -Infinity;
      for (const candidate of candidates) {
        const box = candidate.box;
        const area = box.width * box.height, previousArea = previous.width * previous.height;
        const ratio = area / previousArea;
        if (ratio < 0.35 || ratio > 2.8) continue;
        const overlapWidth = Math.max(0, Math.min(box.x + box.width, previous.x + previous.width) - Math.max(box.x, previous.x));
        const overlapHeight = Math.max(0, Math.min(box.y + box.height, previous.y + previous.height) - Math.max(box.y, previous.y));
        const intersection = overlapWidth * overlapHeight;
        const iou = intersection / (area + previousArea - intersection);
        // Normalize each axis separately: a tall person's height must not make
        // a large sideways jump to their neighbour look like a small motion.
        const relativeDistance = Math.hypot(
          (box.x + box.width / 2 - previous.x - previous.width / 2) / Math.max(0.01, previous.width),
          (box.y + box.height / 2 - previous.y - previous.height / 2) / Math.max(0.01, previous.height),
        );
        if (iou < 0.12 && relativeDistance > 0.65) continue;
        const similarity = iou * 3 - relativeDistance * 0.5 - Math.abs(Math.log(ratio)) * 0.25;
        if (similarity > best) { best = similarity; selected = candidate; }
      }
      if (!selected) {
        ++this._misses;
        const graceMs = Math.max(350, Math.min(2500, interval * 1.5));
        if (this._misses < 2 || capturedAtMs - this._lastSeenAt < graceMs) return missing();
        this._track = null;
      }
    }
    if (!selected) selected = candidates.reduce((best, candidate) => (
      candidate.box.width * candidate.box.height > best.box.width * best.box.height ? candidate : best
    ));
    const subjectKey = this._track?.key || `${frame.kind}:${++this._serial}`;
    this._track = { box: { ...selected.box }, key: subjectKey };
    this._lastSeenAt = capturedAtMs;
    this._misses = 0;
    const box = selected.box;
    return {
      ...frame,
      box,
      point: { x: box.x + box.width / 2, y: box.y + box.height * (frame.kind === 'person' ? 1 : 0.5) },
      confidence: Number.isFinite(selected.confidence) ? selected.confidence : null,
      subjectKey,
    };
  }
}

export class CameraController {
  constructor({ video, onFrame = () => {}, onStatus = () => {}, onZoom = () => {}, onExposure = () => {}, constraintIntervalMs = 40 }) {
    if (!video) throw new TypeError('CameraController requires a video element.');
    this.video = video;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.onZoom = onZoom;
    this._zoom = unavailableZoom();
    this.onExposure = onExposure;
    this._exposure = unavailableExposure();
    this._controlRequests = { zoom: 0, exposureCompensation: 0 };
    this._controlPromises = {};
    this._constraintQueue = Promise.resolve();
    this._constraintCancel = null;
    this._lastConstraintAt = -Infinity;
    this._constraintIntervalMs = Number.isFinite(constraintIntervalMs) ? Math.max(0, Math.min(200, constraintIntervalMs)) : 40;
    this._verifiedControls = {};
    this._generation = 0;
    this._modeGeneration = 0;
    this._detectionMode = 'face';
    this._personDetector = null;
    this._imageRequest = 0;
    this._stream = null;
    this._running = false;
    this._facing = 'environment';
    this._mirrored = false;
    this._startPromise = null;
    this._startFacing = null;
    this._raf = 0;
    this._videoFrameRequest = 0;
    this._frameTimer = 0;
    this._liveInference = null;
    this._inferenceDurationMs = null;
    this._subjectSelector = new SubjectSelector();
    this._observationId = 0;
    this._requestCancel = null;
    this._waitCancel = null;
    this._detector = null;
    this._backend = 'mediapipe';
    this._frameInterval = FRAME_INTERVAL_MS;
    this._detectorPromise = null;
    this._cpuDetectorPromise = null;
    this._detectorQueue = Promise.resolve();
    this._detectorMode = null;
    this._detectorActive = false;
    this._detectorStartingGeneration = null;
    this._lastInference = -Infinity;
    this._lastVideoTime = -1;
    this._lastDetectorTimestamp = 0;
  }

  get running() { return this._running; }
  get facing() { return this._facing; }
  get mirrored() { return this._mirrored; }
  get detectionMode() { return this._detectionMode; }

  /** Track zoom is device controlled; it must not be advertised as optical. */
  getZoomState() { return { ...this._zoom, error: this._zoom.error ? { ...this._zoom.error } : null }; }

  getExposureState() { return { ...this._exposure, error: this._exposure.error ? { ...this._exposure.error } : null }; }

  _emitZoom() { this.onZoom(this.getZoomState()); }
  _emitExposure() { this.onExposure(this.getExposureState()); }
  _controlsPending() { return this._zoom.pending || this._exposure.pending; }

  /** Actual track values only; UI/digital smoothing belongs to zoom-motion.mjs. */
  setZoom(value) { return this._setTrackControl('zoom', value); }
  setExposureCompensation(value) { return this._setTrackControl('exposureCompensation', value); }

  _pauseForControlChange() {
    ++this._modeGeneration;
    this._cancelFrameSchedule();
    this._detectorActive = false;
    this._detectorStartingGeneration = null;
    this._personDetector?.invalidate();
    this._resetObservations();
    this.onFrame(emptyFrame(this.video.videoWidth, this.video.videoHeight, this._mirrored, this._detectionMode));
  }

  /**
   * Both controls share one device queue. Reading constraints at execution time
   * and retaining verified companion values prevents one slider resetting the
   * other. Inputs coalesce per control and identical pending targets share work.
   */
  _setTrackControl(key, value) {
    const field = key === 'zoom' ? '_zoom' : '_exposure';
    const read = key === 'zoom' ? readTrackZoom : readTrackExposure;
    const emit = () => key === 'zoom' ? this._emitZoom() : this._emitExposure();
    const label = key === 'zoom' ? '倍率' : '曝光补偿';
    const prefix = key === 'zoom' ? 'Zoom' : 'Exposure';
    const track = this._stream?.getVideoTracks?.()[0];
    const state = this[field];
    if (!this._running || !track || !state.supported || !Number.isFinite(value)) return Promise.resolve(false);
    const target = clampTrackZoom(value, state);
    if (state.pending && Math.abs(target - state.requested) < 1e-8) return this._controlPromises[key] || Promise.resolve(false);
    if (!state.pending && Math.abs(target - state.value) < 1e-8) return Promise.resolve(true);
    const generation = this._generation;
    const request = ++this._controlRequests[key];
    const trackCurrent = () => this._current(generation) && this._running && this._stream?.getVideoTracks?.()[0] === track;
    const current = () => trackCurrent() && request === this._controlRequests[key];
    const wasPending = this._controlsPending();
    this[field] = { ...state, pending: true, requested: target, error: null };
    emit();
    // A whole gesture invalidates observations once; pointer frequency must not
    // repeatedly tear down and reload the detection scheduling state.
    if (!wasPending) this._pauseForControlChange();

    const job = this._constraintQueue.then(async () => {
      if (!current()) return false;
      let cancel;
      let timer = 0;
      try {
        const cancelled = new Promise(resolve => {
          cancel = () => { if (timer) clearTimeout(timer); resolve(false); };
          this._constraintCancel = cancel;
        });
        const wait = Math.ceil(this._constraintIntervalMs - (nowMs() - this._lastConstraintAt));
        if (wait > 0) {
          const elapsed = new Promise(resolve => { timer = setTimeout(() => { timer = 0; resolve(true); }, wait); });
          if (!await Promise.race([elapsed, cancelled]) || !current()) return false;
        }
        if (!read(track).supported) throw namedError(`${prefix}Unverified`, `相机当前没有可确认的${label}控制能力。`);
        const previous = track.getConstraints?.() || {};
        const { advanced = [], ...constraints } = previous;
        const controlled = new Set([...Object.keys(this._verifiedControls), key]);
        for (const property of controlled) delete constraints[property];
        constraints.advanced = (Array.isArray(advanced) ? advanced : []).map(entry => {
          const copy = { ...entry };
          for (const property of controlled) delete copy[property];
          return copy;
        }).filter(entry => Object.keys(entry).length);
        // Only properties with a genuine settings readback are retained.
        const coupled = { ...this._verifiedControls, [key]: target };
        constraints.advanced.push(coupled);
        this._lastConstraintAt = nowMs();
        const applied = Promise.resolve(track.applyConstraints(constraints)).then(() => true);
        if (!await Promise.race([applied, cancelled]) || !trackCurrent()) return false;
        // Even a superseded request may have changed the device. Keep those
        // actual values for the next transaction, without publishing stale UI.
        const zoom = readTrackZoom(track), exposure = readTrackExposure(track);
        this._verifiedControls = {};
        if (zoom.supported) this._verifiedControls.zoom = zoom.value;
        if (exposure.supported) this._verifiedControls.exposureCompensation = exposure.value;
        if (key !== 'zoom' && !this._zoom.pending && (this._zoom.value !== zoom.value || this._zoom.supported !== zoom.supported)) {
          this._zoom = zoom; this._emitZoom();
        }
        if (key !== 'exposureCompensation' && !this._exposure.pending
          && (this._exposure.value !== exposure.value || this._exposure.supported !== exposure.supported)) {
          this._exposure = exposure; this._emitExposure();
        }
        if (!current()) return false;
        const updated = key === 'zoom' ? zoom : exposure;
        if (!updated.supported) throw namedError(`${prefix}Unverified`, `相机未返回可确认的实际${label}。`);
        const tolerance = Math.max(1e-5, updated.step * 0.01);
        if (Math.abs(updated.value - target) > tolerance) {
          this[field] = { ...updated, error: { code: `${prefix}NotApplied`, message: `相机未采用所选${label}，已显示实际值。` } };
          return false;
        }
        this[field] = updated;
        return true;
      } catch (error) {
        if (!current()) return false;
        const updated = read(track);
        this[field] = {
          ...updated, pending: false, requested: null,
          error: { code: error?.name || `${prefix}ApplyFailed`, message: error?.name === `${prefix}Unverified`
            ? error.message : `当前相机无法采用这个${label}，请重试或调整数值。` },
        };
        if (updated.supported) this._verifiedControls[key] = updated.value;
        else delete this._verifiedControls[key];
        return false;
      } finally {
        if (timer) clearTimeout(timer);
        if (this._constraintCancel === cancel) this._constraintCancel = null;
        if (current()) {
          this[field] = { ...this[field], pending: false, requested: null };
          emit();
          if (!this._controlsPending()) {
            this._resetObservations();
            this._beginDetection(this._generation, this._modeGeneration);
          }
        }
      }
    });
    this._constraintQueue = job.catch(() => false);
    this._controlPromises[key] = job;
    return job;
  }

  /** Selects the detector. When stopped, selection never downloads a model. */
  async setDetectionMode(mode) {
    if (mode !== 'face' && mode !== 'person') throw new TypeError('Detection mode must be face or person.');
    if (mode === this._detectionMode) {
      if (this._running && !this._detectorActive) return this._beginDetection(this._generation, this._modeGeneration);
      return true;
    }
    this._detectionMode = mode;
    ++this._modeGeneration;
    ++this._imageRequest;
    this._cancelFrameSchedule();
    this._detectorActive = false;
    this._detectorStartingGeneration = null;
    this._resetObservations();
    this._personDetector?.invalidate();
    if (!this._running) return true;
    this.onFrame(emptyFrame(this.video.videoWidth, this.video.videoHeight, this._mirrored, mode));
    return this._beginDetection(this._generation, this._modeGeneration);
  }

  _status(state, message, code) {
    this.onStatus({ state, message, ...(code ? { code } : {}) });
  }

  _current(generation) { return generation === this._generation; }
  _detectionCurrent(generation, modeGeneration) {
    return this._current(generation) && modeGeneration === this._modeGeneration;
  }

  _getPersonDetector() {
    if (!this._personDetector) this._personDetector = new PersonDetector();
    return this._personDetector;
  }

  _cancelFrameSchedule() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._videoFrameRequest) this.video.cancelVideoFrameCallback?.(this._videoFrameRequest);
    if (this._frameTimer) clearTimeout(this._frameTimer);
    this._raf = 0;
    this._videoFrameRequest = 0;
    this._frameTimer = 0;
  }

  _resetObservations() {
    this._subjectSelector.reset();
    this._inferenceDurationMs = null;
    this._lastInference = -Infinity;
    this._lastVideoTime = -1;
    // observationId remains monotonic for this controller. It is not a person
    // ID, and resetting the view cannot make an old result look new again.
  }

  _clearStream() {
    this._running = false;
    ++this._controlRequests.zoom;
    ++this._controlRequests.exposureCompensation;
    this._constraintCancel?.();
    this._constraintCancel = null;
    this._constraintQueue = Promise.resolve();
    this._controlPromises = {};
    this._verifiedControls = {};
    this._lastConstraintAt = -Infinity;
    this._zoom = unavailableZoom();
    this._exposure = unavailableExposure();
    this._emitZoom();
    this._emitExposure();
    this._cancelFrameSchedule();
    this._detectorActive = false;
    this._detectorStartingGeneration = null;
    this._personDetector?.invalidate();
    if (this._requestCancel) this._requestCancel();
    this._requestCancel = null;
    if (this._waitCancel) this._waitCancel();
    this._waitCancel = null;
    const stream = this._stream;
    this._stream = null;
    stopTracks(stream);
    this.video.pause();
    this.video.srcObject = null;
    this._resetObservations();
  }

  /** Resolves true once live video is ready. Detection loads independently. */
  async start(facing = this._facing) {
    facing = facing === 'user' ? 'user' : 'environment';
    if (this._startPromise && this._startFacing === facing) return this._startPromise;
    if (this._running && this._facing === facing) {
      if (!this._detectorActive) this._beginDetection(this._generation);
      return true;
    }

    const generation = ++this._generation;
    this._imageRequest++;
    this._clearStream();
    this._facing = facing;
    this._mirrored = facing === 'user';
    this._startFacing = facing;

    const promise = this._openCamera(generation, facing);
    this._startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this._startPromise === promise) {
        this._startPromise = null;
        this._startFacing = null;
      }
    }
  }

  async _openCamera(generation, facing) {
    if (globalThis.isSecureContext === false) {
      this._status('unavailable', '相机需要安全连接。请用 HTTPS 的独立页面打开，再开启相机。', 'InsecureContext');
      return false;
    }
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      this._status('unavailable', '此浏览器暂不支持相机访问。请用系统浏览器打开，或先上传照片。', 'Unsupported');
      return false;
    }
    this._status('requesting', '请允许相机权限，画面只在当前设备内处理。');
    let requestExpired = false;
    let timer;
    let cancelRequest;
    try {
      let requestZoom = false;
      try { requestZoom = navigator.mediaDevices.getSupportedConstraints?.().zoom === true; } catch { /* Optional capability query. */ }
      const pendingStream = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
          frameRate: { ideal: 24, max: 30 },
          // Browsers that gate zoom with camera/PTZ permission need this at
          // the user-initiated camera request. No pan/tilt access is requested.
          ...(requestZoom ? { zoom: true } : {}),
        },
      });
      // A permission prompt cannot be cancelled by JavaScript. Stop any stream
      // that arrives after timeout, stop(), or a newer camera request.
      pendingStream.then((stream) => {
        if (requestExpired || !this._current(generation)) stopTracks(stream);
      }, () => {});
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          requestExpired = true;
          reject(namedError('CameraTimeout', 'Camera request timed out.'));
        }, CAMERA_TIMEOUT_MS);
      });
      const cancelled = new Promise((_, reject) => {
        cancelRequest = () => {
          requestExpired = true;
          reject(namedError('AbortError', 'Camera request cancelled.'));
        };
        this._requestCancel = cancelRequest;
      });
      const stream = await Promise.race([pendingStream, timeout, cancelled]);
      clearTimeout(timer);
      if (this._requestCancel === cancelRequest) this._requestCancel = null;
      if (!this._current(generation)) { stopTracks(stream); return false; }
      this._stream = stream;
      const track = stream.getVideoTracks()[0];
      const reportedFacing = track?.getSettings?.().facingMode;
      if (reportedFacing === 'user' || reportedFacing === 'environment') this._facing = reportedFacing;
      this._mirrored = this._facing === 'user';
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.setAttribute('playsinline', '');
      this.video.srcObject = stream;
      await this._waitForVideo(generation);
      if (!this._current(generation)) return false;
      this._running = true;
      // Some browsers expose capabilities only after video is actually ready.
      this._zoom = readTrackZoom(track);
      this._exposure = readTrackExposure(track);
      if (this._zoom.supported) this._verifiedControls.zoom = this._zoom.value;
      if (this._exposure.supported) this._verifiedControls.exposureCompensation = this._exposure.value;
      this._emitZoom();
      this._emitExposure();
      if (track) {
        track.addEventListener('ended', () => {
          if (!this._current(generation) || !this._running) return;
          ++this._generation;
          this._clearStream();
          this._status('error', '相机连接已中断，请重新开启相机。', 'TrackEnded');
        }, { once: true });
      }
      this.onFrame(emptyFrame(this.video.videoWidth, this.video.videoHeight, this._mirrored, this._detectionMode));
      this._status('ready', '相机已开启，可以拍照。');
      this._beginDetection(generation);
      return true;
    } catch (error) {
      clearTimeout(timer);
      if (!this._current(generation)) return false;
      this._clearStream();
      const info = cameraError(error);
      this._status('error', info.message, info.code);
      return false;
    } finally {
      clearTimeout(timer);
      if (this._requestCancel === cancelRequest) this._requestCancel = null;
    }
  }

  _waitForVideo(generation) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', check);
        this.video.removeEventListener('canplay', check);
        this.video.removeEventListener('error', onError);
        if (this._waitCancel === cancel) this._waitCancel = null;
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (!this._current(generation)) return finish(namedError('AbortError', 'Superseded camera request.'));
        if (this.video.readyState >= 2 && this.video.videoWidth > 0 && this.video.videoHeight > 0) finish();
      };
      const onError = () => finish(namedError('VideoTimeout', 'Camera video could not play.'));
      const cancel = () => finish(namedError('AbortError', 'Camera stopped.'));
      const timer = setTimeout(() => finish(namedError('VideoTimeout', 'Camera video timed out.')), 12000);
      this._waitCancel = cancel;
      this.video.addEventListener('loadedmetadata', check);
      this.video.addEventListener('canplay', check);
      this.video.addEventListener('error', onError);
      try { Promise.resolve(this.video.play()).then(check, finish); }
      catch (error) { finish(error); }
      check();
    });
  }

  /** Stops the old stream before opening the other camera. */
  async switchCamera() {
    if (this._startPromise) return this._startPromise;
    return this.start(this._facing === 'environment' ? 'user' : 'environment');
  }

  /** Cancels callbacks and releases every camera track immediately. */
  stop() {
    ++this._generation;
    ++this._imageRequest;
    this._startPromise = null;
    this._startFacing = null;
    this._clearStream();
    this._status('stopped', '相机已关闭。');
  }

  async _loadDetector() {
    if (this._backend === 'cpu') return this._loadFallbackDetector();
    if (this._detector) return this._detector;
    if (this._detectorPromise) return this._detectorPromise;
    this._detectorPromise = (async () => {
      if (typeof WebAssembly === 'undefined') throw namedError('DetectionUnsupported', 'WebAssembly is not supported.');
      const { FilesetResolver, FaceDetector } = await import(new URL('vision_bundle.mjs', VENDOR).href);
      const vision = await FilesetResolver.forVisionTasks(new URL('wasm', VENDOR).href);
      const detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: new URL('blaze_face_short_range.tflite', VENDOR).href,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.55,
        minSuppressionThreshold: 0.3,
      });
      this._detector = detector;
      this._detectorMode = 'VIDEO';
      return detector;
    })();
    try {
      return await this._detectorPromise;
    } catch (error) {
      this._detectorPromise = null;
      throw error;
    }
  }

  async _loadFallbackDetector() {
    if (this._detector && this._backend === 'cpu') return this._detector;
    if (this._cpuDetectorPromise) return this._cpuDetectorPromise;
    this._cpuDetectorPromise = (async () => {
      const faceapi = await loadFaceApiCpu();
      const detect = async (media, inputSize) => {
        const faces = await faceapi.detectAllFaces(media, new faceapi.TinyFaceDetectorOptions({
          inputSize,
          scoreThreshold: 0.45,
        }));
        return {
          detections: faces.map((face) => ({
            boundingBox: {
              originX: face.box.x,
              originY: face.box.y,
              width: face.box.width,
              height: face.box.height,
            },
            categories: Number.isFinite(face.score) ? [{ score: face.score }] : [],
          })),
        };
      };
      const detector = {
        // This adapter preserves the existing serialized IMAGE/VIDEO API.
        setOptions: async () => {},
        detect: (image) => detect(image, 320),
        detectForVideo: (video) => detect(video, 224),
      };
      this._detector = detector;
      this._detectorMode = null;
      return detector;
    })();
    try {
      return await this._cpuDetectorPromise;
    } catch (error) {
      this._cpuDetectorPromise = null;
      throw error;
    }
  }

  async _activateFallback() {
    this._backend = 'cpu';
    this._frameInterval = CPU_FRAME_INTERVAL_MS;
    const previous = this._detector;
    this._detector = null;
    this._detectorPromise = null;
    this._detectorMode = null;
    // MediaPipe may initialize but fail only when it creates the inference
    // WebGL context. Dispose that instance before retrying on the true CPU net.
    try { previous?.close?.(); } catch { /* A failed graph may reject close. */ }
    return this._loadFallbackDetector();
  }

  _withDetector(operation) {
    // IMAGE/VIDEO mode changes and inference share one serialized queue.
    const generation = this._generation;
    const modeGeneration = this._modeGeneration;
    const job = this._detectorQueue.then(async () => {
      try {
        return await operation(await this._loadDetector());
      } catch (error) {
        if (this._backend === 'cpu' || !this._detectionCurrent(generation, modeGeneration)) throw error;
        if (this._running) this._status('detecting', '正在切换兼容识别，期间仍可参考网格拍照。');
        const detector = await this._activateFallback();
        const result = await operation(detector);
        if (this._detectionCurrent(generation, modeGeneration) && this._running) this._status('ready', '兼容识别已就绪，跟随人脸位置提示调整。');
        return result;
      }
    });
    this._detectorQueue = job.catch(() => {});
    return job;
  }

  async _setMode(detector, mode) {
    if (this._detectorMode === mode) return;
    await detector.setOptions({ runningMode: mode });
    this._detectorMode = mode;
  }

  async _beginDetection(generation, modeGeneration = this._modeGeneration) {
    const token = `${generation}:${modeGeneration}`;
    if (!this._detectionCurrent(generation, modeGeneration) || !this._running || this._controlsPending() || this._detectorStartingGeneration === token) return false;
    this._detectorStartingGeneration = token;
    const mode = this._detectionMode;
    this._status('detecting', mode === 'person'
      ? '正在准备本地人物识别，首次需加载约 20 MB；期间仍可参考网格拍照。'
      : '正在加载本地人脸识别，期间也可以拍照。');
    try {
      if (mode === 'person') await this._getPersonDetector().load();
      else await this._withDetector(async (detector) => {
        if (!this._detectionCurrent(generation, modeGeneration) || !this._running) return;
        await this._setMode(detector, 'VIDEO');
      });
      if (!this._detectionCurrent(generation, modeGeneration) || !this._running) return false;
      this._detectorActive = true;
      this._status('ready', mode === 'person'
        ? (this._personDetector.execution === 'main-cpu' ? '人物识别已就绪，兼容模式的提示更新较慢。' : '人物识别已就绪，跟随人物框和位置提示调整。')
        : '人脸识别已就绪，跟随画面中的位置提示调整。');
      this._scheduleFrame(generation, modeGeneration);
      return true;
    } catch {
      if (!this._detectionCurrent(generation, modeGeneration) || !this._running) return false;
      this._detectorActive = false;
      this._status('unavailable', '自动识别暂时不可用。可参考网格拍照，或导入照片手动调整；再次开启相机可重试识别。', 'DetectorUnavailable');
      return false;
    } finally {
      if (this._detectorStartingGeneration === token) this._detectorStartingGeneration = null;
    }
  }

  _detectionInterval() {
    const person = this._detectionMode === 'person';
    const mainPerson = person && this._personDetector?.execution === 'main-cpu';
    const minimum = person ? (mainPerson ? PERSON_MAIN_INTERVAL_MS : PERSON_WORKER_INTERVAL_MS) : this._frameInterval;
    // A faster device need not wait the former fixed 900/1800 ms. Slower work
    // gets breathing room instead of starting a backlog; main-thread work gets
    // a larger gap. These are sampling policies, not promised camera FPS.
    const dutyFactor = mainPerson ? 2 : 1.25;
    return Math.ceil(Math.max(minimum, (this._inferenceDurationMs || 0) * dutyFactor));
  }

  _scheduleFrame(generation, modeGeneration = this._modeGeneration) {
    if (!this._detectionCurrent(generation, modeGeneration) || !this._running || !this._detectorActive
      || this._liveInference || this._raf || this._videoFrameRequest || this._frameTimer) return;
    const requestFrame = () => {
      if (!this._detectionCurrent(generation, modeGeneration) || !this._running || !this._detectorActive || this._liveInference) return;
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        try {
          this._videoFrameRequest = this.video.requestVideoFrameCallback((_now, metadata) => {
            this._videoFrameRequest = 0;
            this._detectFrame(generation, modeGeneration, metadata);
          });
          return;
        } catch { /* Older/partial implementations use the existing RAF path. */ }
      }
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._detectFrame(generation, modeGeneration);
      });
    };
    const delay = Math.max(0, this._lastInference + this._detectionInterval() - nowMs());
    if (delay > 0) {
      this._frameTimer = setTimeout(() => {
        this._frameTimer = 0;
        requestFrame();
      }, delay);
    } else requestFrame();
  }

  async _detectFrame(generation, modeGeneration = this._modeGeneration, metadata = null) {
    if (!this._detectionCurrent(generation, modeGeneration) || !this._running || !this._detectorActive) return;
    this._cancelFrameSchedule();
    // A mode/source change may occur while an older inference is still running.
    // Its result will be dropped; its finally handler schedules the newest mode.
    if (this._liveInference) return;
    const mode = this._detectionMode;
    const now = nowMs();
    const videoTime = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : this.video.currentTime;
    if (now - this._lastInference < this._detectionInterval() || this.video.readyState < 2 || videoTime === this._lastVideoTime) {
      this._scheduleFrame(generation, modeGeneration);
      return;
    }
    this._lastInference = now;
    this._lastVideoTime = videoTime;
    const liveJob = { generation, modeGeneration };
    this._liveInference = liveJob;
    const current = () => this._detectionCurrent(generation, modeGeneration) && this._running;
    let capturedAtMs = now;
    try {
      let frame;
      if (mode === 'person') {
        frame = await this._getPersonDetector().detect(this.video, { mirrored: this._mirrored, isCancelled: () => !current() });
        if (Number.isFinite(frame?.capturedAtMs)) capturedAtMs = frame.capturedAtMs;
      } else {
        const result = await this._withDetector(async (detector) => {
          if (!current()) return null;
          await this._setMode(detector, 'VIDEO');
          if (!current()) return null;
          // Sampling time is recorded immediately before handing the live image
          // to the detector. It is not an estimated hardware capture timestamp.
          capturedAtMs = nowMs();
          this._lastVideoTime = this.video.currentTime;
          this._lastDetectorTimestamp = Math.max(capturedAtMs, this._lastDetectorTimestamp + 1);
          return detector.detectForVideo(this.video, this._lastDetectorTimestamp);
        });
        if (result) frame = normalizedFrame(result, this.video.videoWidth, this.video.videoHeight, this._mirrored);
      }
      if (!current()) return;
      if (frame) {
        const duration = Number.isFinite(frame.inferenceDurationMs) ? frame.inferenceDurationMs : nowMs() - capturedAtMs;
        this._inferenceDurationMs = Math.max(0, duration);
        this._lastInference = capturedAtMs;
        const expectedIntervalMs = this._detectionInterval();
        const selected = this._subjectSelector.select(frame, { capturedAtMs, expectedIntervalMs });
        this.onFrame({
          ...selected,
          observationId: ++this._observationId,
          capturedAtMs,
          inferenceDurationMs: this._inferenceDurationMs,
          expectedIntervalMs,
        });
      }
    } catch {
      if (!current()) return;
      this._detectorActive = false;
      this._subjectSelector.reset();
      this.onFrame(emptyFrame(this.video.videoWidth, this.video.videoHeight, this._mirrored, mode));
      this._status('unavailable', '自动识别已暂停。可参考网格拍照，或导入照片手动调整；重新开启相机可重试识别。', 'DetectionFailed');
    } finally {
      if (this._liveInference === liveJob) this._liveInference = null;
      // Use the current generation: a late old result must not revive the old
      // loop, but a newly selected and ready mode should not remain stalled.
      this._scheduleFrame(this._generation, this._modeGeneration);
    }
  }

  /**
   * Performs one IMAGE-mode inference without emitting an onFrame callback.
   * Stop the camera first when replacing the live preview with a photo.
   * Errors and cancelled requests return an empty frame with a code/message.
   */
  async detectImage(image, { mode = this._detectionMode } = {}) {
    const { width, height } = mediaSize(image);
    const empty = emptyFrame(width, height, false, mode);
    if (mode !== 'face' && mode !== 'person') return { ...empty, code: 'InvalidMode', error: '请选择人脸或人物识别。' };
    if (!width || !height) return { ...empty, code: 'InvalidImage', error: '照片尚未加载完成，请重试。' };
    const request = ++this._imageRequest;
    const generation = this._generation;
    const modeGeneration = this._modeGeneration;
    const cancelled = () => request !== this._imageRequest || !this._detectionCurrent(generation, modeGeneration);
    try {
      let frame;
      if (mode === 'person') frame = await this._getPersonDetector().detect(image, { isCancelled: cancelled });
      else {
        const result = await this._withDetector(async (detector) => {
          if (cancelled()) return null;
          await this._setMode(detector, 'IMAGE');
          if (cancelled()) return null;
          return detector.detect(image);
        });
        frame = normalizedFrame(result, width, height, false);
      }
      if (cancelled()) return { ...empty, code: 'Cancelled', error: '已取消旧照片的分析。' };
      return frame;
    } catch {
      if (cancelled()) return { ...empty, code: 'Cancelled', error: '已取消旧照片的分析。' };
      return { ...empty, code: 'DetectorUnavailable', error: '自动识别暂时不可用，可以直接点选照片中的主体。' };
    }
  }
}
