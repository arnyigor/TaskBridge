#!/usr/bin/env node
// Knowledge Inspector в терминале (MEM-09, 2026-10-12).
//
// Отвечает на вопросы, ради которых всё делалось, не поднимая сервер:
//   • что проект сейчас помнит (и что из этого больше не про этот проект);
//   • какие предложения ждут человека и почему их не примут;
//   • какие записи попадут в Resume конкретного Work Item — и почему каждая.
//
// Работает офлайн: читает config.json, память проекта и (если попросили) Work Item
// из хранилища. Ничего не пишет и не меняет.
//
// Usage:
//   node scripts/memory-inspect.mjs --project <id|имя|путь> [--query <текст>]
//                                   [--work-item <wi-…>] [--root <repo>]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { PiMemoryMdProvider, resumeMemoryQueries } from '../src/memory/project-memory-provider.mjs';
import { listProposals, proposalCounts, validateProposal } from '../src/memory/memory-proposals.mjs';
import { projectFileIndex } from '../src/memory/path-patterns.mjs';
import { readSavedRecap } from '../src/resume/recap.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const wanted = flag('project');
if (!wanted) {
  console.error('Usage: node scripts/memory-inspect.mjs --project <id|имя|путь> [--query <текст>] [--work-item <wi-…>]');
  process.exit(2);
}

const rootDir = path.resolve(flag('root', repoRoot));
const config = await loadConfig(rootDir);
const projects = config.projects || [];
const project = projects.find(entry => entry.id === wanted)
  ?? projects.find(entry => entry.name === wanted)
  ?? projects.find(entry => entry.path === path.resolve(wanted))
  ?? (await fs.stat(path.resolve(wanted)).then(() => ({ id: path.basename(path.resolve(wanted)), name: path.basename(path.resolve(wanted)), path: path.resolve(wanted) }), () => null));
if (!project) {
  console.error(`Проект не найден: ${wanted}. Известные: ${projects.map(entry => entry.id).join(', ') || '(ни одного)'}`);
  process.exit(2);
}

const provider = new PiMemoryMdProvider({ root: config.memory?.projectMemoryRoot });
const resolved = await provider.resolveProject(project);
const overview = await provider.inspect(project);
const fileIndex = await projectFileIndex(resolved.projectPath);

const heading = text => `\n=== ${text} ===`;
console.log(`Проект      : ${project.name ?? project.id} (${resolved.repoRoot ?? resolved.projectPath})`);
console.log(`Память      : ${resolved.memoryDir}`);
console.log(`Провайдер   : ${overview.provider} · ${overview.status} · запись: ${overview.write}`);
console.log(`Инжектится  : ${overview.injectedAutomatically ? 'да' : 'нет'} · записей ${overview.entries} (живых ${overview.liveEntries ?? '—'}) · ~${overview.approxTokens} токенов индекса`);
if (overview.problems?.length) console.log(`Проблемы    : ${overview.problems.join('; ')}`);

console.log(heading('Устаревшие записи (объявленные пути исчезли)'));
if (!overview.stale?.count) console.log('— нет');
else for (const entry of overview.stale.sources) console.log(`✖ ${entry.source} — нет ни одного из: ${entry.paths.join(', ')}`);

console.log(heading('Что проект помнит (живые записи)'));
const entries = await provider.allEntries(project);
if (!entries.length) console.log('— пусто');
for (const entry of entries) {
  console.log(`• [${entry.category}] ${entry.source} ~${entry.estimatedTokens} ток.`);
  console.log(`  ${entry.text.split('\n')[0].slice(0, 140)}`);
  if (entry.paths?.length) console.log(`  paths: ${entry.paths.join(', ')}`);
}

const query = flag('query');
if (query) {
  console.log(heading(`Поиск: ${query}`));
  const hits = await provider.search(project, query, { limit: 10 });
  if (!hits.length) console.log('— ничего не найдено (это тоже ответ: лексический матч по словам)');
  for (const hit of hits) console.log(`• [${hit.category}] ${hit.source} score=${hit.score} ~${hit.estimatedTokens} ток.\n  ${hit.text}`);
}

console.log(heading('Предложения памяти'));
const proposals = await listProposals(resolved.memoryDir);
const counts = proposalCounts(proposals);
console.log(`ожидают ${counts.pending} · принято ${counts.accepted} · отклонено ${counts.rejected} · отказов на гейтах ${counts.refused ?? 0}`);
if (Object.keys(counts.reasons ?? {}).length) {
  console.log(`частые причины отказа: ${Object.entries(counts.reasons).sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code}×${n}`).join(', ')}`);
}
for (const proposal of proposals.filter(entry => entry.status === 'proposed')) {
  const problems = validateProposal(proposal, { projectPath: resolved.projectPath, fileIndex }).problems;
  console.log(`• ${proposal.id} [${proposal.category}] ${problems.length ? `ПРИНЯТЬ НЕЛЬЗЯ: ${problems.map(problem => problem.code).join(', ')}` : 'готова к принятию'}`);
  console.log(`  ${proposal.text.split('\n')[0].slice(0, 140)}`);
  if (proposal.reason) console.log(`  причина: ${proposal.reason.slice(0, 120)}`);
}

const workItemId = flag('work-item');
if (workItemId) {
  console.log(heading(`Что попадёт в Resume задачи ${workItemId}`));
  const store = new TaskStore(path.resolve(flag('data', path.join(rootDir, 'data'))));
  try {
    const item = store.getWorkItem(workItemId);
    if (!item) {
      console.log('— задача не найдена в этом хранилище');
    } else {
      const links = store.workItemSessions(item.id);
      // Сессии читаются так же, как их читает Resume: сохранённый recap плюс то,
      // что известно про их рабочую папку. Никаких выдуманных полей.
      const sessions = links.map(link => {
        const saved = readSavedRecap(store.taskDir(link.sessionId));
        return { sessionId: link.sessionId, recap: saved?.recap ?? { remaining: [], accomplished: [] }, changedFiles: [] };
      });
      const changedFiles = sessions.flatMap(session => session.changedFiles);
      const queries = resumeMemoryQueries(item, sessions, { changedFiles });
      console.log(`Цель        : ${item.goal ?? '—'}`);
      console.log(`Критерии    : ${(item.acceptanceCriteria ?? []).join(' | ') || '—'}`);
      console.log(`Связи       : ${links.map(link => `${link.sessionId} (${link.relation})`).join(', ') || '—'}`);
      console.log('Запросы к памяти (по ним выбираются выдержки):');
      for (const text of queries) console.log(`  · ${text.slice(0, 120)}`);
      const relevant = await provider.relevant(project, { queries, budgetTokens: 2000, limit: 8 });
      console.log(`Выбрано     : ${relevant.hits.length} записей, ~${relevant.estimatedTokens} токенов (бюджет 2000)`);
      for (const hit of relevant.hits) console.log(`  ✓ ${hit.source} — ${hit.reason}`);
      if (!relevant.hits.length) console.log('  — ни одна запись не подошла; Resume всё равно работает без памяти');
    }
  } finally {
    store.close();
  }
}
console.log('');
