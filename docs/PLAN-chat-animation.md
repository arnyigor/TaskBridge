---
taskbridge_plan: 1
plan_id: p-chat-animation
revision: 5
goal: "Вернуть прежнюю скорость анимации в чате: индикатор набора не должен мелькать быстрее, чем до 66b89ec, и не должен вернуть 60 кадров в секунду в простое"
---

# План: скорость анимации в чате

## Шаги

### S-001 | DONE | P1 | Зафиксировать цифры: что именно «слишком быстро»
**Критерии:** в чате ответа плана записаны три факта с числами: текущий шаг индикатора (`TYPING_STEP_MILLIS = 140` мс ≈ 7 шагов/с в `clients/kmp/.../ui/common/Components.kt:158`), прежняя анимация до `66b89ec` (`rememberInfiniteTransition` + `tween(600, delayMillis = index * 180)`, `RepeatMode.Reverse`) и веб-индикатор (`.typing i { animation: blink 1.2s }` со стаггером 0.18 s в `web/app.css`). Без вывода «нравится/не нравится» — только измерения.
**Проверка:** `grep -n TYPING_STEP_MILLIS clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/common/Components.kt`, `git show 66b89ec^:clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/common/Components.kt | grep -n "tween(600"`, `grep -n "animation: blink" web/app.css`
**Результат:** [MODEL_REPORTED] 158: const val TYPING_STEP_MILLIS = 140L; 177: delay(TYPING_STEP_MILLIS) → фаза меняется 1000/140 = 7.1 раз/с, полный цикл трёх точек 3×140 = 420 мс; 158: rememberInfiniteTransition(label = "typing"); 164: infiniteRepeatable(tween(600, delayMillis = index * 180), RepeatMode.Reverse) → 600 мс на полуцикл, 1200 мс туда-обратно, стаггер точек 0/180/360 мс; 1063: animation: blink 1.2s infinite ease-in-out; 1065-1066: animation-delay .18s / .36s → период 1200 мс, тот же стаггер 180 мс, что был в KMP до 66b89ec; план перечитан перед ходом: planId p-chat-animation, revision 1, S-001 TODO как в задании; цифры в критериях S-001 совпали с кодом без расхождений

### S-002 | DONE | P1 | Вернуть прежний ритм индикатора одним параметром
**Критерии:** ритм точек в KMP снова читается как до `66b89ec`: либо плавное затухание 600 мс с тем же стаггером 180 мс между точками, либо ступенчатая смена фазы не чаще 3–4 раз в секунду (260–300 мс на шаг) — выбранный вариант обоснован одной строкой в комментарии рядом с константой. Скорость задаётся ровно в одном месте (`TYPING_STEP_MILLIS` либо `tween(...)`), другие места анимации не трогаются: спиннеры загрузки, «Ждёт ответа» и появление элементов остаются как есть.
**Проверка:** `git diff` затрагивает только индикатор набора; `:shared:jvmTest --tests "ru.arny.taskbridge.ui.common.IndicatorAnimationTest"` зелёный после обновления ожидаемого диапазона изменений в секунду.
**Результат:** [MODEL_REPORTED] TYPING_STEP_MILLIS 140L → 280L (3.57 смены фазы/с, цикл 840 мс против 1200 мс у плавной анимации до 66b89ec); в комментарии рядом с константой одна строка обоснования: плавный tween вернул бы перерисовку всего окна 60 раз в секунду; diff затрагивает только Components.kt (+9/−1) и IndicatorAnimationTest.kt (+7/−1); rememberInfiniteTransition в commonMain больше нет, других значений шага (140L/180) в индикаторе нет — скорость задана в одном месте; 5/5 зелёные после обновления ожидаемого диапазона на 2..5 изменений/с (было 3..8): typingIndicatorStepsInsteadOfSixtyFramesPerSecond, typingIndicatorInIdleRequestsNoFrames, workingIndicatorsAreStillInsteadOfRepaintingForever, attentionFlashPlaysAndThenStops, aRowWithoutNewsDoesNotAnimate

### S-003 | DONE | P1 | Не вернуть постоянную перерисовку в простое
**Критерии:** без активного ответа индикатор не запрашивает кадры (0 изменений за секунду) и не меняет ни одного пикселя; во время ответа число изменений в секунду соответствует выбранному ритму (не 60). Это то свойство, ради которого `66b89ec` и делался: замедление не должно его отменить.
**Проверка:** `IndicatorAnimationTest` (простой — 0 кадров; ответ — 2–8 изменений/с), `:shared:jvmTest` целиком без падений.
**Результат:** [MODEL_REPORTED] 299 тестов, 0 падений. Простой: typingIndicatorInIdleRequestsNoFrames — ни одного запроса кадра за 0..1000 мс и 0 изменений картинки за 300 мс; во время ответа — 3.6 изменения/с вместо 60

### S-004 | DONE | P2 | Сверить веб-индикатор с новым ритмом
**Критерии:** в Web точки мигают в том же темпе, что и в KMP: `animation: blink` и задержки `nth-child(2|3)` приведены к выбранным значениям, блок `prefers-reduced-motion` сохранён и работает. Никаких новых JS-таймеров не добавлено.
**Проверка:** `grep -n "blink\|animation-delay" web/app.css`, `node --test tests/web-css.test.mjs`, значение `animation-duration` в DevTools на реальной странице.
**Результат:** [MODEL_REPORTED] .typing i: animation blink 1.2s → .84s (цикл = 840 мс = 3×280 мс, как шаг фазы в KMP), задержки nth-child .18s/.36s → .28s/.56s; в тот же блок добавлено @media (prefers-reduced-motion: reduce) { .typing i { animation: none; opacity: .6 } }; на живой странице вычисленные стили точек: duration 0.84s у всех трёх, delays 0s / 0.28s / 0.56s, animation-name blink, iteration-count infinite; с эмуляцией reduced_motion=reduce animation-name = none у всех трёх; 17/17 зелёные после правки CSS; grep подтверждает строки 1064 (blink .84s), 1066-1067 (.28s/.56s), 1070 (reduce → animation: none); изменены только Components.kt, IndicatorAnimationTest.kt (цикл c-2) и web/app.css; web/app.js не менялся — новых JS-таймеров нет

### S-005 | DONE | P2 | Проверить глазами и прогнать регресс
**Критерии:** на Desktop и в Android в живом чате (ход модели идёт) точки читаются плавно и не быстрее, чем до `66b89ec`; убедительно не по памяти, а по записи: скринкаст 5–10 с или серия кадров с интервалом 200 мс. После правки: `npm test` и `:shared:jvmTest` без падений, изменения ограничены индикатором набора.
**Проверка:** скринкаст в `.local/`, вывод `npm test` и `:shared:jvmTest`, `git diff --stat` — только файлы индикатора (и CSS, если S-004 тронул).
**Результат:** [MODEL_REPORTED] Desktop: 12 кадров продакшн-композабла TypingIndicator через ImageComposeScene с шагом 200 мс в .local/fp-ux-05/typing-frames; ровно 3 различных состояния, альфа точек по кадрам 255/153/77 → 153/77/255 → 77/255/153, т.е. волна идёт шагом 280 мс с циклом 840 мс; мозаика .local/fp-ux-05/typing-frames/mosaic.png; Android: живой чат, «Pi работает», точки в ленте видны; 4 снимка с интервалом ~0.55 с дают разные тройки яркостей (тёмная точка смещается на ~2 позиции за интервал = 280 мс/шаг), без мерцания всех трёх одновременно; мозаика .local/fp-ux-05/android-typing-frames.png, кадры .local/fp-ux-04/android/typing-run-0*.png; 1628 тестов: 1624 pass, 4 skipped, 0 fail (166.6 с); 299 тестов, 0 падений; node --test tests/web-css.test.mjs — 17/17; изменения ограничены индикатором: Components.kt (+9/−2), IndicatorAnimationTest.kt (+4/−3), web/app.css (+8/−3); временный TypingFramesDump.kt удалён, git status чист по отношению к нему

## Обнаруженные проблемы

- F-001 | P2 | OPEN | Веб-индикатор набора игнорирует prefers-reduced-motion: правила для .typing/.blink нет — существующие блоки reduce касаются только .restartSpinner, .bareIcon.restarting и .runSpinner (web/app.css:345-347, 406), а .typing i продолжает blink 1.2s infinite. S-004 в текущей формулировке этого не покрывает: в нём сказано «блок prefers-reduced-motion сохранён и работает», то есть предполагается существующее правило для точек, которого нет — S-004 касается темпа (значение blink и задержек nth-child), а не добавления правила reduce. (относится к S-004)
