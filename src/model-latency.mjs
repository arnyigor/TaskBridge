import fs from 'node:fs/promises';
import path from 'node:path';

// Ответная задержка модели (TTFT: отправка промпта → первый токен) по каждой
// модели. TaskManager пишет один сэмпл на каждое сообщение ассистента — и для
// локальных, и для облачных моделей (для облачных это единственный честный
// показатель «долго ли молчит провайдер»). /api/models подмешивает скользящую
// статистику в каталог, чтобы UI мог показать «модель обычно отвечает за ~N с»
// ещё до отправки запроса.

const MAX_SAMPLES = 20;

// Mirrors the client's ModelRef.key (`${provider}/${id}` with an empty provider
// rendered as an empty string): the sample must land under the key the UI looks
// up, and Pi does not always name the provider.
function keyOf(model) {
  return model?.id ? `${model.provider || ''}/${model.id}` : null;
}

// The median of a sorted list; with an even count the two middle samples are averaged.
function median(sorted) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export class ModelLatency {
  constructor(dataRoot) {
    this.file = path.join(dataRoot, 'model-latency.json');
    this.byModel = new Map();
    this.loaded = false;
  }

  // Best effort: первый запуск — пустого файла нет, битый файл — начинаем заново.
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const map = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [key, samples] of Object.entries(map || {})) {
        if (Array.isArray(samples)) this.byModel.set(key, samples.filter(s => s && Number.isFinite(Number(s.ttftMs))));
      }
    } catch { /* no file yet */ }
  }

  async record(model, ttftMs) {
    const key = keyOf(model);
    if (!key || !Number.isFinite(ttftMs) || ttftMs <= 0) return;
    await this.load();
    const samples = this.byModel.get(key) || [];
    samples.push({ ttftMs: Math.round(ttftMs), at: new Date().toISOString() });
    this.byModel.set(key, samples.slice(-MAX_SAMPLES));
    try {
      await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.byModel), null, 2));
    } catch { /* best effort disk persistence */ }
  }

  // { [provider/modelId]: { count, avgMs, p50Ms, lastMs, samples } }
  stats() {
    const out = {};
    for (const [key, samples] of this.byModel) {
      const values = samples.map(s => Number(s.ttftMs)).filter(Number.isFinite).sort((a, b) => a - b);
      if (!values.length) continue;
      out[key] = {
        count: values.length,
        avgMs: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
        p50Ms: median(values),
        lastMs: values[values.length - 1],
        samples: samples.slice(-10)
      };
    }
    return out;
  }
}
