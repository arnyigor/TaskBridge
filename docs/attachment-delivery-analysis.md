# Анализ: вложения в чат и отличие desktop / Android

Дата проверки: 2026-10-07. Объект: текущее рабочее дерево TaskBridge. Проверка ограничена кодом и существующими тестовыми стендами; реальный установленный Pi/модель и конкретная пользовательская сессия не исследовались.

## Короткий вывод

В текущей архитектуре есть два разных смысла слова «прикрепить»:

1. **Пользователь прикрепляет файл к запросу.** Это реализовано: клиент читает файл в память, сервер принимает multipart upload, копирует файл в рабочую папку `.taskbridge-input/...`, сохраняет метаданные в `task.attachments/files`, а в prompt для Pi добавляет путь к файлу.
2. **Модель прикрепляет файл к своему ответу.** Прямого API «assistant attachment» нет. Модель может только создать файл в рабочей папке и дать Markdown-ссылку вида `[Download report](report.pdf)`. После завершения хода сервер отдельно ищет изменённые файлы и кладёт их в `outputFiles`; сам текст ответа при этом остаётся обычным Markdown.

Поэтому фраза модели «я не могу прикрепить файл к чату» может быть формально верной для второго смысла: модель не умеет отправить бинарное вложение как часть сообщения. Но она должна уметь **создать файл в рабочей папке и сослаться на него**. TaskBridge потом может открыть такой относительный Markdown-link и/или показать файл в панели результатов.

## Как проходит пользовательское вложение

### Клиент

- Общий UI держит выбранные файлы в `files: List<UploadFile>` и перед `send()` вызывает `session.send(text, files, mode)`.
- `ChatSession.send()` сразу добавляет optimistic user bubble с `FileRef`, затем в `deliver()` сначала вызывает `api.upload(files)`, потом `/api/tasks/:id/message` с `uploadToken` и ids файлов.
- `TaskBridgeApi.upload()` отправляет `/api/uploads` через multipart и заголовок `x-taskbridge-upload: 1`.

Ключевые файлы:

- [`clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/chat/ChatScreen.kt`](../clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/chat/ChatScreen.kt)
- [`clients/kmp/core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/session/ChatSession.kt`](../clients/kmp/core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/session/ChatSession.kt)
- [`clients/kmp/core/api/src/commonMain/kotlin/ru/arny/taskbridge/core/api/TaskBridgeApi.kt`](../clients/kmp/core/api/src/commonMain/kotlin/ru/arny/taskbridge/core/api/TaskBridgeApi.kt)

### Сервер

- [`src/uploads.mjs`](../src/uploads.mjs): принимает multipart в `data/uploads/<token>/<id>`, пишет `index.json`, возвращает token + список ids.
- [`src/task-manager.mjs`](../src/task-manager.mjs): `#resolveFiles()`/`stageFiles()` переносят файлы в task storage и в workspace.
- [`src/files.mjs`](../src/files.mjs): `stageFiles()` копирует файл в `.taskbridge-input/<taskId>/<fileId>/<name>` и создаёт записи `attachments/files`.
- Для модели строится текстовая подсказка: `Additional files from the phone are in .taskbridge-input/: ...`. Это не «нативное вложение» протокола модели, а путь к файлу в рабочей папке.

## Может ли файл быть прикреплён, но чат его «не распознал»?

Да, есть несколько разных уровней распознавания:

1. **Сервер принял файл.** Проверяется по `task.attachments` и наличию файла в `.taskbridge-input/...`.
2. **Чат показывает файл у пользовательского сообщения.** Для `USER_MESSAGE` сервер передаёт `files: attached`; reducer показывает chips/preview. Есть тест, что служебная строка `.taskbridge-input` не должна показываться как текст сообщения, а должна стать файлом.
3. **Модель реально прочитала файл.** Это не гарантируется самим фактом upload. Модель/agent должен открыть путь из prompt. Для картинок дополнительно нужна vision-модель и не должен быть включён Pi `images.blockImages`.
4. **Файл, созданный моделью, виден пользователю.** Это уже output capture после ответа, а не attachment в самом сообщении. В KMP-чате turn output files намеренно не дублируются chips внутри assistant bubble; они доступны через Markdown-ссылку/просмотрщик и через список файлов результата.

То есть возможна ситуация: файл успешно uploaded и отображён в истории, но модель отвечает «не вижу/не могу прикрепить», потому что она не прочитала путь, выбрана text-only модель, Pi заблокировал изображения, или модель ожидает «нативное вложение», которого TaskBridge не предоставляет.

## Desktop vs Android

После превращения в `UploadFile` путь общий: multipart upload → server staging → `.taskbridge-input` → prompt.

Различия только на входе:

| Возможность | Desktop | Android |
|---|---|---|
| Скрепка | AWT `FileDialog`, читает обычные файлы с диска | Android SAF `GetMultipleContents`, читает `content://` URI |
| Clipboard | Файлы из file manager (`javaFileListFlavor`) и image clipboard, image сохраняется как PNG | Только URI из clipboard item; текстовый clipboard не является файлом |
| Drag & drop | Поддержан через `javaFileListFlavor` | Не поддержан, функции возвращают пусто/no-op |
| MIME | `Files.probeContentType()` | `ContentResolver.getType(uri)` |
| Имя | `file.name` | `OpenableColumns.DISPLAY_NAME`, fallback `file` |

Android-специфичные риски:

- `readUri()` возвращает `null`, если провайдер не дал имя/поток или чтение упало; UI при пустом результате сейчас просто не добавляет файлы, без отдельной ошибки.
- Clipboard на Android берёт только `clip.item.uri`; если приложение кладёт картинку/файл в другом формате, TaskBridge покажет «В буфере нет картинки или файлов».
- Большие файлы читаются в память целиком на обеих платформах; серверный лимит upload — до 10 файлов, 64 MiB на файл, 128 MiB суммарно.

Desktop-специфичные возможности: drag-and-drop и clipboard-файлы из проводника. На Android их нет, но скрепка через системный picker должна идти тем же серверным путём.

## Vision / изображения

Для картинки одного upload недостаточно. По коду есть отдельные условия:

- `chooseEngine()` выбирает vision profile только если auto-настройка знает `visionProfile`; иначе image остаётся на text profile с причиной `text (no vision profile; ... image file(s) attached)`.
- `/api/info` предупреждает, если в Pi включён `images.blockImages`: тогда Pi заменяет картинки на текст `Image reading is disabled.` до провайдера.
- Каталог моделей несёт признак `images`; text-only модель не станет понимать картинку из-за того, что файл лежит в `.taskbridge-input`.

## Что проверять в конкретной сессии

Для одного `taskId`:

1. В `task.attachments` есть запись нужного файла: `name`, `size`, `mimeType`, `path`.
2. В workspace существует файл по `path` из `.taskbridge-input/...`.
3. Событие `USER_MESSAGE` содержит `data.files`, а не только текстовую строку `Additional files...`.
4. В prompt/логах Pi есть путь к файлу.
5. Для картинки: модель в task имеет `images: true`/выбран vision profile, а `/api/info.warnings` не содержит `PI_IMAGES_BLOCKED`.
6. Если проблема про файл-результат от модели: файл создан в workspace, не игнорируется git, не превышает лимиты `captureOutputs`, и ссылка в ответе относительная: `[Download report](report.pdf)`.

## Подтверждённые проверки

- Node server tests подтвердили: создание задачи только из файла, multipart upload, staging в workspace, сохранение `attachments`, выдача файла через `/api/tasks/:id/files/:fileId`, удаление upload staging.
- KMP JVM test подтвердил: строка `Additional files from the phone...` не остаётся текстом пользовательского сообщения, а превращается в file item в чате.

## Вероятная причина жалобы

Если модель пишет именно «не могу прикрепить файл к чату», наиболее вероятно, что она говорит про **исходящий файл результата**: TaskBridge не даёт модели операции `attach_file_to_chat`. Правильный сценарий — создать файл в рабочей папке и дать Markdown-ссылку. Если же речь о входном файле пользователя, тогда нужно смотреть конкретную сессию по списку выше: upload мог пройти, но модель могла не открыть путь или не иметь vision-доступа.
