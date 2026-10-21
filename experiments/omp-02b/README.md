# experiments/omp-02b — структурные инструменты OMP

Узкий эксперимент после OMP-02: проверяет `ast_grep`, `ast_edit` и `edit` в режиме
`hashline`, которые в OMP-02 были недоступны (`astGrep.enabled` по умолчанию `false`).
Результаты и вывод — [docs/omp-02b-ast-tools.md](../../docs/omp-02b-ast-tools.md).

```
fixtures/build.mjs   синтетические проекты ast01, ast02, edit01, edit02 + ground-truth.json
checks.mjs           проверка по состоянию среды: answer.json, verify.js, нетронутые файлы
run-ast.mjs          прогон 4 сценариев × 3 плеча (pi-plain, omp-plain, omp-ast)
```

```bash
# профиль OMP с включённым AST-поиском (один раз)
omp --profile omp02b-ast config set astGrep.enabled true

node experiments/omp-02b/run-ast.mjs --variant all --timeout 180000
node experiments/omp-02b/run-ast.mjs --variant omp-ast --only ast01,edit02 --out .local/omp02b/one
```

Что важно в постановке:

- модели одна на все плечи (`deepseek/deepseek-flash`), меняется только ядро и
  доступность AST-инструментов;
- `bash` нет ни в одном плече — иначе структурный поиск подменяется `grep`/`sed`;
- критерий правильности — состояние файлов и `answer.json`, а не рассказ модели;
- правило «править только функцию» принимает замену тела и отвергает правку чужих
  функций (проверено на двух случаях, см. docs).

Всё пишется в `.local/omp02b/run-<время>/` (вне Git): `run.json` на прогон и
`summary.json` на серию.
