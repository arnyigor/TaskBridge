package ru.arny.taskbridge.ui.processes

import ru.arny.taskbridge.core.api.CleanupPlan
import ru.arny.taskbridge.core.api.CleanupResult
import ru.arny.taskbridge.core.api.TaskBridgeJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// Разбор ответов /api/system/cleanup/* проверяется здесь, а не в :core:api:
// shared компилирует исходники core через srcDir, его jvmTest запускается
// одним прогоном с тестами экрана. JSON снят с живого preview (имена полей и
// лишние поля записи процесса: parentPid/commandLine приходят как есть).
class CleanupPayloadTest {

    private val previewJson = """
        {
          "planId": "cf3e7fbc-03ea-46b8-831a-a22181fc05f6",
          "objective": "gpu",
          "createdAt": "2026-10-19T06:27:28.798Z",
          "expiresAt": 1792391308798,
          "snapshotRevision": 297,
          "candidates": [
            {
              "pid": 19912,
              "parentPid": 4092,
              "startedAt": 1792391195867,
              "name": "llama-server.exe",
              "memoryBytes": 1837039616,
              "commandLine": "llama-server.exe -m model.gguf --port 8080"
            },
            {
              "pid": 13360,
              "parentPid": 13156,
              "startedAt": 1792390142858,
              "name": "chrome.exe",
              "memoryBytes": 253181952,
              "commandLine": "chrome.exe --type=gpu-process"
            }
          ],
          "protectedSkipped": [{ "pid": 4, "name": "System", "reason": "protected" }],
          "warnings": [
            "Per-process VRAM под Windows WDDM недостоверна — фактический эффект измеряется по глобальной занятой VRAM после очистки."
          ],
          "estimatedRamBytes": 2090221568
        }
    """.trimIndent()

    private val executeJson = """
        {
          "planId": "cf3e7fbc-03ea-46b8-831a-a22181fc05f6",
          "commandId": "6f1d0f8c-6f3b-4c0c-9a1e-0d0f6d6f1c11",
          "finishedAt": "2026-10-19T06:28:02.101Z",
          "items": [
            { "pid": 19912, "name": "llama-server.exe", "status": "STOPPED" },
            { "pid": 13360, "name": "chrome.exe", "status": "PROTECTED", "detail": "защищённый процесс" },
            { "pid": 4242, "name": "python.exe", "status": "ALREADY_EXITED" }
          ],
          "stopped": 1,
          "protectedCount": 1,
          "failedCount": 0,
          "ram": { "freeBeforeBytes": 8589934592, "freeAfterBytes": 12884901888, "observedDeltaBytes": 4294967296 },
          "gpu": { "usedBeforeMb": 6144, "usedAfterMb": 1536, "sampledAt": "2026-10-19T06:28:02.000Z" }
        }
    """.trimIndent()

    @Test
    fun cleanupPreviewPayloadKeepsCandidatesAndProtectedSkips() {
        val plan = TaskBridgeJson.decodeFromString(CleanupPlan.serializer(), previewJson)
        assertEquals("cf3e7fbc-03ea-46b8-831a-a22181fc05f6", plan.planId)
        assertEquals("gpu", plan.objective)
        assertEquals(2, plan.candidates.size)
        assertEquals("llama-server.exe", plan.candidates.first().name)
        assertEquals(1_837_039_616L, plan.candidates.first().memoryBytes)
        assertEquals(1, plan.protectedSkipped.size)
        assertEquals("protected", plan.protectedSkipped.first().reason)
        assertEquals(2_090_221_568L, plan.estimatedRamBytes)
        assertTrue(plan.warnings.isNotEmpty(), "предупреждение про WDDM обязано доехать до диалога")
        assertNotNull(plan.expiresAt, "TTL плана приходит числом — по нему видно, что план короткоживущий")
    }

    @Test
    fun cleanupExecutePayloadKeepsPerProcessStatusesAndVramDelta() {
        val result = TaskBridgeJson.decodeFromString(CleanupResult.serializer(), executeJson)
        assertEquals(1, result.stopped)
        assertEquals(1, result.protectedCount)
        assertEquals(0, result.failedCount)
        assertEquals(listOf("STOPPED", "PROTECTED", "ALREADY_EXITED"), result.items.map { it.status })
        assertEquals(6144L, result.gpu?.usedBeforeMb)
        assertEquals(1536L, result.gpu?.usedAfterMb)
        // Итоговая строка экрана читает именно эти поля.
        assertEquals("Остановлено: 1 · защищено: 1 · VRAM: 6.0 ГБ → 1.5 ГБ", cleanupResultNote(result))
    }
}
