// Hugging Face Hub — источник локальных моделей.
//
// Слой не знает ничего о llama.cpp, Strata и запуске моделей: он умеет искать
// репозитории, читать дерево файлов и разбирать GGUF-варианты (кванты, шардированные
// файлы, mmproj-проекторы). Запуск — забота runtime-слоя, скачивание — DownloadManager.
//
// Используются публичные REST-эндпоинты Хабра-хаба:
//   GET /api/models?search=…        — поиск репозиториев
//   GET /api/models/{repo}/tree/{revision}?recursive=true — дерево файлов
//   GET /{repo}/resolve/{revision}/{path} — скачивание файла (это делает DownloadManager)
// Это стабильные, документированные эндпоинты huggingface_hub; при ошибке сервиса
// ответ уходит наверх как есть, без изобретения своих кодов.

const DEFAULT_BASE_URL = 'https://huggingface.co';

// Распознаваемые кванты. Покрываем общепринятые имена llama.cpp (включая
// imatrix-суффиксы вида "…-UD-Q4_K_XL") и полноточности (F16/BF16/FP32).
const QUANT_TOKENS = [
  'IQ1_M', 'IQ1_S', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M', 'IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M', 'IQ4_XS', 'IQ4_NL',
  'Q2_K_S', 'Q2_K_M', 'Q2_K', 'Q3_K_XL', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q3_K', 'Q4_K_S', 'Q4_K_M', 'Q4_K', 'Q4_0', 'Q4_1',
  'Q5_K_S', 'Q5_K_M', 'Q5_K', 'Q5_0', 'Q5_1', 'Q6_K', 'Q8_0',
  'BF16', 'F16', 'FP16', 'F32', 'FP32'
];

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * Квант из имени файла GGUF. В отличие от quantFromPath в local-models.mjs
 * (берёт последний сегмент после "-") ищет известный токен кванта: в имени
 * "Qwen3.8-27B-UD-IQ1_S.gguf" последний сегмент — "UD", а не квант.
 * Возвращает null, если узнаваемого кванта в имени нет.
 */
export function quantFromFilename(name) {
  if (!name) return null;
  const base = String(name).replace(/\.gguf$/i, '');
  for (const token of QUANT_TOKENS) {
    // Границы: токен не должен быть хвостом более длинного буквенно-цифрового слова.
    const re = new RegExp(`(^|[-_. ])${token}(?=$|[-_. ])`, 'i');
    if (re.test(base)) return token;
  }
  return null;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry.path !== 'string') return null;
  // Размер у LFS-файлов лежит в entry.lfs.size; у мелких файлов — в entry.size.
  const size = Number(entry.lfs?.size ?? entry.size);
  return {
    path: entry.path,
    name: entry.path.split('/').pop(),
    size: Number.isFinite(size) && size >= 0 ? size : null,
    type: entry.type || null
  };
}

/**
 * Разбор дерева репозитория GGUF-модели на варианты. Чистая функция — покрыта
 * тестами без сети.
 *
 * Шардированные файлы ("…-00001-of-00003.gguf") группируются в один вариант:
 * качать нужно все части, поэтому размер варианта — сумма частей, и вариант
 * помечается shards: N. Пока в репозитории неполный набор частей, вариант
 * помечается incomplete — качать его нельзя.
 */
export function analyzeGgufTree(entries) {
  const items = (Array.isArray(entries) ? entries : []).map(normalizeEntry).filter(Boolean);
  const variants = new Map(); // quant → { quant, files: [], totalBytes, shards }
  const projectors = [];
  const other = [];

  for (const entry of items) {
    if (!/\.gguf$/i.test(entry.name)) {
      // Не GGUF (README, токенизатор, safetensors) — показываем в «прочем»,
      // но в варианты и проекторы не попадает.
      if (entry.path.includes('/')) { /* вложенные не-GGUF тоже «прочее» */ }
      other.push(entry);
      continue;
    }
    if (/mmproj/i.test(entry.name)) {
      projectors.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        quant: quantFromFilename(entry.name)
      });
      continue;
    }
    const shard = SHARD_RE.exec(entry.name);
    const base = shard ? shard[1] : entry.name.replace(/\.gguf$/i, '');
    const quant = quantFromFilename(base) || '—';
    if (!variants.has(quant)) variants.set(quant, { quant, files: [], totalBytes: 0, shards: null, complete: true });
    const variant = variants.get(quant);
    variant.files.push({ path: entry.path, size: entry.size });
    variant.totalBytes += entry.size ?? 0;
    if (shard) {
      const expected = Number(shard[3]);
      variant.shards = Math.max(variant.shards ?? 0, expected);
    }
  }

  // Полный ли набор шардов у каждого варианта.
  for (const variant of variants.values()) {
    if (variant.shards) {
      const firstParts = variant.files.filter(f => SHARD_RE.test(f.path.split('/').pop()));
      variant.complete = firstParts.length === variant.shards;
    }
    variant.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  return {
    variants: [...variants.values()].sort((a, b) => a.totalBytes - b.totalBytes),
    projectors,
    other
  };
}

export class HuggingFaceService {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Токен нужен для gated/private репозиториев. Его передаёт владелец
    // (env HF_TOKEN / файл data/hf-token) — в config.json он не пишется.
    this.token = options.token || null;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 30000));
  }

  #headers() {
    const headers = { 'user-agent': 'TaskBridge' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async #get(pathname) {
    const res = await fetch(this.baseUrl + pathname, {
      headers: this.#headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) {
      const error = new Error(
        res.status === 401 ? 'Hugging Face: требуется токен (HF_TOKEN).' :
        res.status === 403 ? 'Hugging Face: доступ к репозиторию запрещён (gated-модель или нет прав).' :
        res.status === 404 ? `Hugging Face: репозиторий не найден.` :
        `Hugging Face: HTTP ${res.status}`);
      error.code = res.status === 401 || res.status === 403 ? 'HF_AUTH' : 'HF_ERROR';
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  /** Поиск репозиториев. filter=gguf — тег Хабра, отсекающий не-GGUF модели. */
  async search(query, { limit = 20, ggufOnly = true } = {}) {
    const params = new URLSearchParams({ search: query || '', limit: String(limit), sort: 'downloads', direction: '-1' });
    if (ggufOnly) params.set('filter', 'gguf');
    const payload = await this.#get(`/api/models?${params}`);
    return (Array.isArray(payload) ? payload : []).map(item => ({
      repo: item.id || null,
      author: item.id ? item.id.split('/')[0] : null,
      name: item.id ? item.id.split('/').slice(1).join('/') : null,
      downloads: Number(item.downloads) || 0,
      likes: Number(item.likes) || 0,
      lastModified: item.lastModified || null,
      gated: item.gated === true || typeof item.gated === 'string',
      pipelineTag: item.pipeline_tag || null
    })).filter(item => item.repo);
  }

  /** Сырое дерево файлов репозитория. */
  async repoTree(repo, revision = 'main') {
    if (!repo || typeof repo !== 'string' || repo.includes('..')) {
      throw Object.assign(new Error('Некорректный репозиторий.'), { code: 'INPUT_INVALID' });
    }
    return this.#get(`/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`);
  }

  /** Дерево, разобранное на варианты. Используется UI и планированием загрузки. */
  async analyze(repo, revision = 'main') {
    const tree = await this.repoTree(repo, revision);
    const analyzed = analyzeGgufTree(tree);
    // Реальная revision (commit sha) для привязки установленной модели: дерево
    // отдаёт один и тот же список, но sha мы получаем отдельным запросом.
    let resolvedRevision = revision;
    try {
      const info = await this.#get(`/api/models/${repo}/revision/${encodeURIComponent(revision)}`);
      if (info?.sha) resolvedRevision = info.sha;
    } catch { /* без sha живём с именем revision */ }
    return { repo, revision: resolvedRevision, ...analyzed };
  }

  /**
   * План загрузки: выбранные файлы + суммарный размер. Размеры берутся из
   * дерева, не от клиента — клиент присылает только пути. Возвращает null для
   * файла, которого нет в дереве.
   */
  plan(treeEntries, requestedPaths) {
    if (!Array.isArray(requestedPaths) || !requestedPaths.length) return null;
    const byPath = new Map((treeEntries || []).map(normalizeEntry).filter(Boolean).map(e => [e.path, e]));
    const files = [];
    for (const requested of requestedPaths || []) {
      const entry = byPath.get(String(requested));
      if (!entry) return null; // неизвестный путь — план недействителен целиком
      files.push({ path: entry.path, size: entry.size });
    }
    return { files, totalBytes: files.reduce((sum, f) => sum + (f.size ?? 0), 0) };
  }
}
