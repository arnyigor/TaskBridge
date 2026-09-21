import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone llama.cpp PP/TG probe. Run: node scripts/bench-llama-pp.mjs --preset <name>
//
// It boots its OWN llama-server on a spare port instead of driving the
// always-on router on :8080: unloading/reloading through the router would kill
// whatever Pi session is currently pointed at it. The router is never touched.
//
// PP/TG come from the server's own timings (timings.prompt_per_second in the
// /completion reply), not from wall-clock around fetch(), so HTTP and JSON
// overhead cannot inflate them. The --metrics counters are the fallback — the
// same source src/local-models.mjs feeds the UI from.
//
// Every load and unload is bracketed by a timestamped report, so the wait is
// never a silent black box: `[t+…] --- load: ПЕРЕД ---` before, the same after.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now();
const stamp = () => `t+${((Date.now() - started) / 1000).toFixed(1)}s`;

const log = line => console.log(`[${stamp()}] ${line}`);

function report(title, rows) {
  console.log(`\n--- ${stamp()} ${title} ---`);
  for (const [key, value] of rows) console.log(`  ${String(key).padEnd(20)} ${value}`);
  console.log('');
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) { out[token.slice(2, eq)] = token.slice(eq + 1); continue; }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[name] = true;
    } else if (name in out) {
      out[name] = [].concat(out[name], next);
      i++;
    } else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

// models.ini mirrors llama.cpp CLI flags 1:1: the key is the long flag without
// the leading dashes, `true` means "pass the flag", `false` means "pass its
// --no- form". Section [*] is the shared base and the named section overrides
// it — the same merge the router itself performs for a child server.
function readIni(file) {
  const sections = new Map();
  let current = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      current = section[1].trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!kv || !current) continue;
    sections.get(current).set(kv[1], kv[2].trim());
  }
  return sections;
}

// Keys the router consumes itself and never forwards to the child: each child
// is started by the router with its own --host/--port (port 0 = pick a free
// one), so forwarding ours would collide with that.
const ROUTER_ONLY = new Set(['models-max', 'models-autoload', 'models-dir', 'models-preset', 'host', 'port']);

function presetArgs(sections, name) {
  if (!sections.has(name)) {
    throw new Error(`В models.ini нет секции [${name}]. Есть: ${[...sections.keys()].filter(k => k !== '*').join(', ')}`);
  }
  const merged = new Map([...(sections.get('*') || new Map()), ...sections.get(name)]);
  const args = [];
  for (const [key, value] of merged) {
    if (ROUTER_ONLY.has(key)) continue;
    if (value === 'true') args.push(`--${key}`);
    else if (value === 'false') args.push(`--no-${key}`);
    else args.push(`--${key}`, value);
  }
  return args;
}

// A repeated single-value flag makes the CLI11 parser unhappy (or silently wins
// last, depending on the build), so overrides REPLACE the entry instead of
// being appended after it. The same routine removes a flag the build rejected.
function stripFlag(args, key) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token !== `--${key}` && token !== `--no-${key}`) { out.push(token); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) i++;
  }
  return out;
}

function setFlag(args, key, value) {
  const rest = stripFlag(args, key);
  if (value === true) return [...rest, `--${key}`];
  if (value === false) return [...rest, `--no-${key}`];
  return [...rest, `--${key}`, String(value)];
}

function vram() {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=memory.used,memory.free', '--format=csv,noheader,nounits'],
      { windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        const [used, free] = String(stdout).trim().split(/\r?\n/)[0].split(',').map(part => Number(part.trim()));
        resolve(Number.isFinite(used) ? { used, free } : null);
      });
  });
}

const vramText = async () => {
  const value = await vram();
  return value ? `${value.used} MiB занято, ${value.free} MiB свободно` : 'nvidia-smi недоступен';
};

// Working set of the child itself, not of the machine: this is what tells mmap
// (file pages, shared, evictable) apart from a real read into the process — the
// claim "--lazy-mode keeps the N-gram table pageable on SSD" only shows up here.
function processMemory(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve(null);
    execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).WorkingSet64`],
      { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        if (error) return resolve(null);
        const value = Number(String(stdout).trim());
        resolve(Number.isFinite(value) ? value : null);
      });
  });
}

const mib = bytes => (bytes == null ? '—' : `${(bytes / 1048576).toFixed(0)} MiB`);

async function getJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, ok: response.ok, body, text };
}

// Roughly one token per word for this filler. The true count is read back from
// timings.prompt_n, so an off estimate only shifts the prompt length, it cannot
// falsify the rate.
function buildPrompt(words) {
  const unit = 'The quick brown fox jumps over the lazy dog and then considers the consequences of its actions.';
  const perUnit = unit.split(' ').length;
  return Array.from({ length: Math.max(1, Math.ceil(words / perUnit)) }, () => unit).join(' ');
}

function pickLines(lines, patterns, limit = 12) {
  const hit = lines.filter(line => patterns.some(pattern => pattern.test(line)));
  return hit.length > limit ? [...hit.slice(0, 4), `... ещё ${hit.length - 4} строк ...`, ...hit.slice(-(limit - 4))] : hit;
}

function killTree(proc) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

// One load attempt: spawn, wait for /health, keep the child's own log so a
// failure explains itself instead of surfacing as "did not start".
async function attemptLoad({ server, cwd, args, port, loadTimeoutMs, logPath }) {
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${stamp()} attempt: ${server} ${args.join(' ')}\n`);
  const lines = [];
  const proc = spawn(server, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = chunk => {
    logStream.write(chunk);
    // llama.cpp renders progress with a bare CR, so splitting on \n alone keeps
    // a whole load in one giant "line" and makes the summary pick nothing.
    for (const line of chunk.toString('utf8').split(/\r\n|\r|\n/u)) if (line.trim()) lines.push(line.trim());
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);

  let exited = null;
  proc.on('close', (code, signal) => { exited = { code, signal }; });

  const start = Date.now();
  let ready = false;
  let lastNote = 0;
  let peakWs = null;
  while (Date.now() - start < loadTimeoutMs) {
    if (exited) break;
    const health = await getJson(`http://127.0.0.1:${port}/health`, 2500).catch(() => null);
    if (health?.ok) { ready = true; break; }
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastNote >= 10) {
      lastNote = elapsed;
      const ws = await processMemory(proc.pid);
      if (ws != null) peakWs = Math.max(peakWs ?? 0, ws);
      const note = lines.filter(line => /load_tensors|offload|mmap|CPU_Mapped|CUDA0 model buffer|KV self|n_ctx|graph/i.test(line)).slice(-1)[0];
      log(`загрузка… ${elapsed.toFixed(0)}c, RAM ${mib(peakWs)}${note ? ` | ${note.slice(0, 100)}` : ''}`);
    }
    await sleep(1000);
  }
  const ws = await processMemory(proc.pid);
  if (ws != null) peakWs = Math.max(peakWs ?? 0, ws);
  await new Promise(resolve => logStream.end(resolve));
  return { ready, exited, lines, seconds: (Date.now() - start) / 1000, proc, peakWs };
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const configPath = path.join(rootDir, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const router = config.localRuntime?.router || {};

  const iniPath = argv.ini ? path.resolve(String(argv.ini)) : path.join(rootDir, 'models.ini');
  const sections = readIni(iniPath);

  const preset = argv.preset ? String(argv.preset) : null;
  const model = argv.model ? String(argv.model) : (preset ? sections.get(preset)?.get('model') : null);
  if (!model) throw new Error('Нужен --preset <секция models.ini> или --model <первый шард .gguf>.');

  const server = path.resolve(String(argv.server || router.command || 'llama-server.exe'));
  const cwd = argv.cwd ? path.resolve(String(argv.cwd)) : (router.cwd || path.dirname(server));
  const port = Number(argv.port || 8081);
  const loadTimeoutMs = Number(argv['load-timeout'] || 300) * 1000;
  const promptWords = Number(argv['prompt-tokens'] || 2048);
  const predict = Number(argv.predict || 32);
  const repeats = Number(argv.repeats || 2);
  const label = String(argv.label || preset || path.basename(model).replace(/\.gguf$/i, ''));

  // The preset carries its own `model` (and would collide with ours if both
  // were appended), so the probe-owned flags are set, not prepended.
  let args = preset ? presetArgs(sections, preset) : [];
  args = setFlag(args, 'model', model);
  args = setFlag(args, 'host', '127.0.0.1');
  args = setFlag(args, 'port', String(port));
  // A distinct alias: the router on :8080 already serves the preset name, and
  // two servers answering to the same model id is a confusing thing to debug.
  args = setFlag(args, 'alias', `bench-${label}`);

  // Anything the probe does not own is passed straight through as a llama.cpp
  // flag: `--load-mode none` has to mean exactly that and not a silent no-op.
  // Only the short convenience spellings are translated, because `--batch` and
  // friends are not real llama.cpp flags and would be rejected (or worse, look
  // accepted while the preset's value stays in force).
  const ALIASES = {
    b: 'batch-size', ub: 'ubatch-size', c: 'ctx-size', t: 'threads', tb: 'threads-batch',
    batch: 'batch-size', ubatch: 'ubatch-size', ctx: 'ctx-size', ngl: 'n-gpu-layers',
    ncmoe: 'n-cpu-moe', cmoe: 'cpu-moe'
  };
  const OWN = new Set(['preset', 'model', 'server', 'cwd', 'port', 'ini', 'json', 'label', 'prompt-tokens', 'predict', 'repeats', 'load-timeout', 'dry-run', 'extra']);
  const cliFlags = new Set();
  for (const [key, value] of Object.entries(argv)) {
    if (OWN.has(key)) continue;
    const flag = ALIASES[key] || key;
    cliFlags.add(flag);
    args = setFlag(args, flag, value);
  }
  for (const extra of [].concat(argv.extra || [])) args = [...args, ...String(extra).split(/\s+/)];
  // The probe needs the timings counters; a preset without --metrics would
  // otherwise silently fall back to the (unreliable) rate gauges.
  args = setFlag(args, 'metrics', true);

  const jsonPath = path.resolve(String(argv.json || path.join(rootDir, 'data', 'runtime', `bench-${label}.json`)));
  const logPath = path.join(rootDir, 'data', 'runtime', `bench-${label}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.rmSync(logPath, { force: true });
  // Cleared up front so its existence later means "written by this run".
  fs.rmSync(jsonPath, { force: true });

  const command = `${server} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  if (argv['dry-run']) {
    report('dry-run: команда без запуска', [['server', server], ['cwd', cwd], ['port', port], ['args', args.join(' ')], ['json', jsonPath], ['log', logPath]]);
    return;
  }

  const busy = await getJson(`http://127.0.0.1:${port}/health`, 1500).catch(() => null);
  if (busy?.ok) throw new Error(`Порт ${port} уже занят отвечающим сервером — выберите --port.`);

  report('load: ПЕРЕД загрузкой', [
    ['модель', model],
    ['пресет', preset || '(нет, флаги с командной строки)'],
    ['порт', port],
    ['VRAM', await vramText()],
    ['лимит загрузки', `${loadTimeoutMs / 1000} c`],
    ['лог', logPath],
    ['команда', command]
  ]);

  // The running router tolerates preset keys its child build does not know (it
  // never forwarded --stop-timeout to the children — see /models args). A
  // standalone child does not, so a rejected flag is dropped and the launch
  // retried instead of us guessing which ini keys are dead in this build.
  let loaded = null;
  let attempt = 0;
  const dropped = [];
  while (attempt < 8) {
    attempt++;
    loaded = await attemptLoad({ server, cwd, args, port, loadTimeoutMs, logPath });
    if (loaded.ready) break;
    const invalid = loaded.lines.join('\n').match(/invalid argument: (--[\w-]+)/u);
    if (!invalid) break;
    const key = invalid[1].replace(/^--/u, '');
    // A preset key this build no longer knows is dead config and can be dropped.
    // A flag typed on the command line is different: silently dropping it would
    // report numbers for a configuration nobody asked for.
    if (cliFlags.has(ALIASES[key] || key)) {
      throw new Error(`Сборка отклонила флаг ${invalid[1]}, заданный вручную: ${loaded.lines.slice(-3).join(' | ')}`);
    }
    args = stripFlag(args, key);
    dropped.push(invalid[1]);
    log(`отброшен ${invalid[1]}: в этой сборке такого ключа нет — перезапуск без него`);
  }

  const { ready, exited, lines, seconds: loadSeconds, proc, peakWs } = loaded;
  const summary = pickLines(lines, [
    /n_cpu_moe|n-cpu-moe/i, /offloaded|offloading|CPU_Mapped|CUDA0 model buffer/i,
    /KV self|kv cache/i, /flash_attn|flash attn/i, /lazy/i, /mmap/i
  ]);
  report(ready ? `load: ПОСЛЕ загрузки (${loadSeconds.toFixed(1)} c, попыток: ${attempt})` : `load: ПРОВАЛ (${loadSeconds.toFixed(1)} c)`, [
    ['state', ready ? 'READY' : `НЕ ГОТОВ (exit=${exited ? `${exited.code}/${exited.signal}` : '—'})`],
    ['время загрузки', `${loadSeconds.toFixed(1)} c`],
    ['RAM процесса', mib(peakWs)],
    ['VRAM', await vramText()],
    ['отброшено флагов', dropped.length ? dropped.join(', ') : 'нет'],
    ['лог', logPath]
  ]);
  if (summary.length) { console.log(summary.map(line => `    ${line}`).join('\n')); console.log(''); }
  if (!ready) console.log(lines.slice(-25).map(line => `    ! ${line}`).join('\n'));

  const result = { label, preset, model, port, droppedFlags: dropped, args, loadSeconds, attempts: attempt, peakProcessBytes: peakWs, ready, samples: [] };

  try {
    if (!ready) throw new Error('Сервер не поднялся за отведённое время.');

    // Warmup is deliberately explicit (the presets pass --no-warmup): one short
    // request so the measured runs are not paying CUDA graph/kernel cold start.
    await fetch(`http://127.0.0.1:${port}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: buildPrompt(64), n_predict: 8, temperature: 0, cache_prompt: false, stream: false }),
      signal: AbortSignal.timeout(120000)
    }).then(r => r.json()).catch(() => null);
    log('warmup выполнен');

    for (let run = 1; run <= repeats; run++) {
      const before = await vramText();
      log(`замер ${run}/${repeats}: промпт ~${promptWords} слов, ждём завершения…`);
      const t0 = Date.now();
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/completion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: buildPrompt(promptWords), n_predict: predict, temperature: 0, top_k: 1, cache_prompt: false, stream: false }),
          signal: AbortSignal.timeout(600000)
        });
      } catch (error) {
        // "fetch failed" alone is useless when the server died mid-prefill:
        // the child's own last words are what say whether it was an OOM.
        const tail = await new Promise(resolve => fs.readFile(logPath, 'utf8', (err, text) => resolve(
          err ? '' : text.split(/\r\n|\r|\n/u).filter(Boolean).slice(-12).join('\n'))));
        throw new Error(`Запрос не прошёл (${error.message}). Последние строки лога:\n${tail}`);
      }
      const body = await response.json();
      const wall = (Date.now() - t0) / 1000;
      const timings = body.timings || null;
      let pp = timings?.prompt_per_second ?? null;
      let tg = timings?.predicted_per_second ?? null;
      let source = 'timings';
      if (pp == null) {
        // Fallback: the cumulative counters behind llama.cpp /metrics, the same
        // fields src/local-models.mjs derives the UI rates from.
        const metrics = await getJson(`http://127.0.0.1:${port}/metrics`, 3000);
        const value = name => {
          const match = String(metrics.text || '').match(new RegExp(`^${name} ([\\d.eE+-]+)$`, 'mu'));
          return match ? Number(match[1]) : null;
        };
        const promptTokens = value('llamacpp:prompt_tokens_total');
        const promptSeconds = value('llamacpp:prompt_seconds_total');
        const predictedTokens = value('llamacpp:tokens_predicted_total');
        const predictedSeconds = value('llamacpp:tokens_predicted_seconds_total');
        if (promptTokens && promptSeconds) pp = promptTokens / promptSeconds;
        if (predictedTokens && predictedSeconds) tg = predictedTokens / predictedSeconds;
        source = 'metrics';
      }
      const sample = {
        run, source, wallSeconds: Number(wall.toFixed(2)),
        promptTokens: timings?.prompt_n ?? null,
        promptSeconds: timings?.prompt_ms != null ? Number((timings.prompt_ms / 1000).toFixed(3)) : null,
        predictedTokens: timings?.predicted_n ?? null,
        pp: pp != null ? Number(pp.toFixed(2)) : null,
        tg: tg != null ? Number(tg.toFixed(2)) : null,
        vramBefore: before, vramAfter: await vramText()
      };
      result.samples.push(sample);
      report(`замер ${run}/${repeats}`, [
        ['источник', source],
        ['prompt', `${sample.promptTokens ?? '?'} токенов за ${sample.promptSeconds ?? '?'} c`],
        ['PP', sample.pp != null ? `${sample.pp} tok/s` : 'нет данных'],
        ['TG', sample.tg != null ? `${sample.tg} tok/s (${sample.predictedTokens ?? '?'} токенов)` : 'нет данных'],
        ['wall', `${sample.wallSeconds} c`],
        ['VRAM', `${before}  →  ${sample.vramAfter}`]
      ]);
    }

    const best = result.samples.filter(s => s.pp != null).sort((a, b) => b.pp - a.pp)[0];
    if (best) report('ИТОГ', [['лучший PP', `${best.pp} tok/s`], ['TG при нём', best.tg != null ? `${best.tg} tok/s` : '—'], ['VRAM', best.vramAfter]]);
    // Persisted before the unload: killing the child is the step most likely to
    // be interrupted, and losing the numbers to a Ctrl-C there is absurd.
    fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    log(`отчёт: ${jsonPath}`);
  } finally {
    report('unload: ПЕРЕД выгрузкой', [['pid', proc.pid], ['VRAM', await vramText()]]);
    const unloadStart = Date.now();
    await killTree(proc);
    // Tearing down an 84 GB mmap can take a while after the kill lands, and the
    // 'close' event only fires when the process is really gone — but exitCode is
    // already set by then, so poll that instead of a fixed 30 s guess.
    while (proc.exitCode == null && proc.signalCode == null && Date.now() - unloadStart < 90000) await sleep(500);
    report('unload: ПОСЛЕ выгрузки', [
      ['exit', exited ? `${exited.code ?? '—'}/${exited.signal ?? '—'}` : `код ${proc.exitCode ?? '—'} (close-событие не пришло)`],
      ['время выгрузки', `${((Date.now() - unloadStart) / 1000).toFixed(1)} c`],
      ['VRAM', await vramText()],
      ['лог', logPath]
    ]);
    // Safety net for the failure paths that never reach the write above.
    if (!fs.existsSync(jsonPath)) {
      fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
      log(`отчёт: ${jsonPath}`);
    }
  }
}

main().catch(error => {
  console.error(`[${stamp()}] ошибка: ${error.message}`);
  process.exitCode = 1;
});
