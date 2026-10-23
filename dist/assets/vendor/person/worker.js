/* App worker; upstream libraries and weights are pinned alongside this file. */
let modelPromise = null;
let inferenceQueue = Promise.resolve();

async function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      importScripts('tf.min.js', 'coco-ssd.min.js');
      await tf.setBackend('cpu');
      await tf.ready();
      return cocoSsd.load({
        base: 'lite_mobilenet_v2',
        modelUrl: new URL('model/model.json', self.location.href).href,
      });
    })().catch((error) => { modelPromise = null; throw error; });
  }
  return modelPromise;
}

self.addEventListener('message', ({ data }) => {
  const task = inferenceQueue.then(async () => {
    const model = await loadModel();
    if (data.type === 'load') return { backend: 'cpu' };
    if (data.type !== 'detect') throw new Error('Unsupported operation');
    const { width, height } = data;
    const pixels = new Uint8Array(data.pixels);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 640 || height > 640 || pixels.length !== width * height * 4) throw new Error('Invalid frame');
    const tensor = tf.browser.fromPixels({ data: pixels, width, height }, 3);
    try { return await model.detect(tensor, 20, data.minScore ?? 0.4); }
    finally { tensor.dispose(); }
  });
  inferenceQueue = task.catch(() => {});
  task.then(
    (result) => self.postMessage({ id: data.id, ok: true, result }),
    () => self.postMessage({ id: data.id, ok: false, code: 'PersonModelUnavailable' }),
  );
});
