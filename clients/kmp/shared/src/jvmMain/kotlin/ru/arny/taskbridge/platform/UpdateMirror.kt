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
     * Значения для PowerShell-параметров скрипта обновления; разделитель — точка
     * с запятой, скрипт превращает их в `/XD …` и `/XF …`.
     */
    fun excludedDirSpec(): String = protectedDirNames.joinToString(";")
    fun excludedFileSpec(): String = protectedFileNames.joinToString(";")
}
