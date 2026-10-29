/* Web Worker: keeps the large dataset and the route search off the UI thread. */
importScripts('data.js', 'optimizer.js', 'engine.js');

const engine = self.TDEngine.createEngine();

self.onmessage = async (e) => {
  const msg = e.data || {};
  const progress = (p) => self.postMessage({ type: 'progress', id: msg.id, progress: p });
  try {
    if (msg.type === 'load') {
      const info = await engine.load(msg.url, progress);
      self.postMessage({ type: 'ready', info });
    } else if (msg.type === 'run') {
      self.postMessage({ type: 'result', id: msg.id, result: await engine.run(msg.opts, progress) });
    } else if (msg.type === 'reprice') {
      self.postMessage({ type: 'result', id: msg.id, result: engine.reprice(msg.args) });
    } else if (msg.type === 'quick') {
      self.postMessage({ type: 'result', id: msg.id, result: await engine.quick(msg.args, progress) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
