package ru.arny.taskbridge.platform

/**
 * Что обновление НЕ ИМЕЕТ ПРАВА трогать внутри каталога установки (PKG-03).
 *
 * DesktopUpdater зеркалит staging на каталог программы (`robocopy /MIR`), а `/MIR`
 * удаляет в цели всё, чего нет в источнике. Пока настройки и данные лежали рядом с
 * бинарниками, обновление стирало их.
 *
 * Исключения задаются ИМЕНАМИ, а не абсолютными путями: проверено на живом
 * robocopy, что `/XD <абсолютный путь>` надёжно защищает только первый уровень
 * (`data`), а вложенный (`server/data`) всё равно удаляется. Имя же действует на
 * любой уровень — `server/data`, `server/logs`, `data`.
 *
 * Цена решения: программа не может содержать собственный каталог `data`, `logs`,
 * `backups` или `config` — и не содержит: сборка поставки их не копирует.
 */
object UpdateMirror {
    /** Имена каталогов, которые сохраняются на любом уровне вложенности. */
    val protectedDirNames: List<String> = listOf("data", "logs", "backups", "config")

    /** Имена файлов настроек, которые сохраняются. */
    val protectedFileNames: List<String> = listOf("config.json")

    /**
     * Собственный мусор обновлятора: старые файлы, переименованные rename-dance
     * (`vcruntime140.old-1-0.dll`-подобные). Их нельзя отдавать под удаление `/MIR`:
     * пока держатель (например llama-server с загруженной из runtime DLL) не отпустил
     * файл, попытка его удалить даёт robocopy код 8 — и следующее обновление снова
     * «падает» на файлах, которые вообще не нужно было трогать. Подчищаются они
     * отдельно, когда держатель их отпустил (скрипт после успешного запуска).
     */
    val updaterLeftoverFilePatterns: List<String> = listOf("*.old-*")

    /**
     * Значения для PowerShell-параметров скрипта обновления; разделитель — точка
     * с запятой, скрипт превращает их в `/XD …` и `/XF …`.
     */
    fun excludedDirSpec(): String = protectedDirNames.joinToString(";")
    fun excludedFileSpec(): String = (protectedFileNames + updaterLeftoverFilePatterns).joinToString(";")
}
