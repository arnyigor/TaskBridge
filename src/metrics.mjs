// Minimal in-process metrics registry (§89). No external dependency: counters,
// gauges and simple observations, exportable as JSON or Prometheus text.
//
// Names follow the specification:
//   cloud_event_upload_latency_ms, cloud_event_batch_size,
//   cloud_event_retry_count, cloud_outbox_size, cloud_command_latency_ms,
//   realtime_reconnect_count, task_event_lag, heartbeat_failure_count

function key(name, labels) {
  const entries = Object.entries(labels || {}).filter(([, value]) => value != null).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${String(v).replaceAll('"', '')}"`).join(',')}}`;
}

export class Metrics {
  constructor({ maxSeries = 2000, observationWindow = 512 } = {}) {
    this.maxSeries = maxSeries;
    // Последние значения каждой серии — для перцентилей (p95 и т.п.): агрегаты
    // (count/sum/min/max) перцентиль не дают, а хранить всё — путь к
    // неограниченной памяти. Окно ограничено жёстко.
    this.observationWindow = observationWindow;
    this.counters = new Map();
    this.gauges = new Map();
    this.observations = new Map();
    this.recent = new Map();
    this.startedAt = new Date().toISOString();
  }

  #guard(series) {
    if (series.size <= this.maxSeries) return true;
    // A runaway label value must not grow memory without bound.
    const oldest = series.keys().next().value;
    series.delete(oldest);
    return true;
  }

  increment(name, value = 1, labels = {}) {
    const id = key(name, labels);
    this.counters.set(id, (this.counters.get(id) || 0) + Number(value || 0));
    this.#guard(this.counters);
    return this;
  }

  set(name, value, labels = {}) {
    this.gauges.set(key(name, labels), Number(value || 0));
    this.#guard(this.gauges);
    return this;
  }

  observe(name, value, labels = {}) {
    const id = key(name, labels);
    const current = this.observations.get(id) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    const number = Number(value || 0);
    current.count += 1;
    current.sum += number;
    current.min = Math.min(current.min, number);
    current.max = Math.max(current.max, number);
    this.observations.set(id, current);
    let recent = this.recent.get(id);
    if (!recent) { recent = []; this.recent.set(id, recent); }
    recent.push(number);
    if (recent.length > this.observationWindow) recent.splice(0, recent.length - this.observationWindow);
    this.#guard(this.recent);
    return this;
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.observations.clear();
    this.recent.clear();
    return this;
  }

  snapshot() {
    const observations = {};
    for (const [id, value] of this.observations) {
      observations[id] = { count: value.count, sum: value.sum, avg: value.count ? value.sum / value.count : 0, min: value.min === Infinity ? 0 : value.min, max: value.max === -Infinity ? 0 : value.max };
    }
    for (const [id, recent] of this.recent) {
      observations[id].p95 = percentile(recent, 0.95);
    }
    return {
      startedAt: this.startedAt,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      observations
    };
  }

  toPrometheus() {
    const lines = [];
    for (const [id, value] of this.counters) lines.push(`${id} ${value}`);
    for (const [id, value] of this.gauges) lines.push(`${id} ${value}`);
    for (const [id, value] of this.observations) {
      lines.push(`${id}_count ${value.count}`);
      lines.push(`${id}_sum ${value.sum}`);
      lines.push(`${id}_max ${value.max === -Infinity ? 0 : value.max}`);
      const recent = this.recent.get(id);
      if (recent?.length) lines.push(`${id}_p95 ${percentile(recent, 0.95)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Перцентиль по окну последних значений: линейная интерполяция, как у Prometheus histogram_quantile на глаз, но детерминированно. */
export function percentile(sortedSource, quantile) {
  const values = [...(sortedSource || [])].sort((a, b) => a - b);
  if (!values.length) return 0;
  const position = (values.length - 1) * Math.min(1, Math.max(0, Number(quantile) || 0));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}
