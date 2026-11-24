package ru.arny.taskbridge.ui.chat

/**
 * Машина прокрутки ленты чата: «оператор у низа» ([BottomLatch]) и «позиция чтения»
 * ([ReadingAnchor]). Вынесена из ChatScreen.kt без изменения поведения.
 *
 * Файл сознательно без Compose-зависимостей: это чистые состояния и правила,
 * они тестируются на JVM напрямую (BottomLatchTest, ReadingAnchorTest), а
 * Compose-проводка (snapshotFlow, NestedScrollConnection, LaunchedEffect) живёт
 * в экране и подключается к этой машине.
 */

/** Насколько близко к нижней границе считается «у низа», в dp. */
internal const val NEAR_BOTTOM_DP = 40

/**
 * Нужно ли вернуть ленте позицию чтения после прихода контента.
 *
 * Отдельная функция, потому что именно охрана здесь и ошибается: вернуть ленту в
 * момент, когда палец ею двигает, — это лишний скролл поверх жеста (а на
 * desktop это уже приводило к аварийному завершению), а возврат к тому же месту,
 * где пользователь и стоит, — бессмысленная работа на каждый дельта-чанк.
 */
internal fun needsReadingRestore(
    following: Boolean,
    scrolling: Boolean,
    currentIndex: Int,
    currentOffset: Int,
    targetIndex: Int,
    targetOffset: Int,
): Boolean {
    if (following || scrolling) return false
    if (targetIndex < 0) return false
    return currentIndex != targetIndex || currentOffset != targetOffset
}

/**
 * Якорь чтения: элемент, на котором стоит оператор, вместе со смещением внутри него.
 *
 * Почему отдельным объектом, а не двумя `remember` в композабле: инвариант здесь
 * ровно один и его нужно уметь проверять — «пришёл контент, а позиция чтения та же».
 * Элемент адресуется КЛЮЧОМ, а не индексом: при новой дельте или при догрузке
 * старой страницы индексы сдвигаются, а ключ — нет (2026-10-14).
 */
internal class ReadingAnchor {
    var key: String? = null
        private set
    var offset: Int = 0
        private set

    /**
     * Позиция ленты изменилась: запоминаем, где оператор остановился.
     *
     * Раньше запоминание шло только при `isScrollInProgress` (то есть при жесте или
     * анимации). Колесо мыши и мгновенные переходы этот флаг не поднимают, якорь
     * оставался от прошлого жеста — и первая же дельта возвращала ленту туда: «скролл
     * в самый низ при получении чанков» и «скролл вверх при добавлении элемента»
     * (оператор 2026-10-17). Поэтому теперь запоминается любая позиция, которую
     * сдвинул не приход контента, а сам оператор — любым способом.
     */
    fun record(contentArrived: Boolean, index: Int, offset: Int, keyOf: (Int) -> String?) {
        if (contentArrived) return
        keyOf(index)?.let { key = it }
        this.offset = offset
    }

    /**
     * Куда вернуть ленту, если она уехала от якоря; null — возвращать нечего
     * (нет якоря, элемент исчез из ленты, оператор внизу или двигает ленту сам).
     */
    fun target(
        following: Boolean,
        scrolling: Boolean,
        currentIndex: Int,
        currentOffset: Int,
        indexOf: (String) -> Int,
    ): Pair<Int, Int>? {
        val anchorKey = key ?: return null
        val index = indexOf(anchorKey)
        if (!needsReadingRestore(following, scrolling, currentIndex, currentOffset, index, offset)) return null
        return index to offset
    }
}

/**
 * «Оператор у низа ленты» — защёлка, а не мгновенный замер.
 *
 * Замер `firstVisibleItemIndex == 0` ошибается ровно в тот момент, когда решается
 * судьба ленты: новый элемент встаёт нулевым, прежний низ уезжает на индекс 1, и
 * лента, которую никто не трогал, считается прокрученной вверх — новый элемент
 * остаётся за нижней границей, а «Новое» загорается на пустом месте. Поэтому уход
 * от низа засчитывается только тогда, когда позиция изменилась БЕЗ прихода
 * контента: значит, это жест, колесо или программный переход.
 */
internal class BottomLatch(private val nearBottomPx: Int = 80) {
    var following: Boolean = true
        private set
    private var seenCount: Int = -1
    private var seenNewest: String? = null
    private var pausedByUser = false
    private var returningToBottom = false

    // reverseLayout: положительная дельта жеста/колеса ведёт к старым сообщениям.
    // Намерение важнее порога «рядом с низом» и прихода контента в том же кадре.
    fun userScroll(deltaY: Float) {
        if (deltaY > 0f) {
            pausedByUser = true
            returningToBottom = false
            following = false
        } else if (deltaY < 0f) {
            returningToBottom = true
        }
    }

    fun resume() {
        pausedByUser = false
        returningToBottom = false
        following = true
    }

    private fun keepPaused(index: Int, offset: Int): Boolean {
        if (!pausedByUser) return false
        if (returningToBottom && index == 0 && offset == 0) {
            resume()
            return false
        }
        following = false
        return true
    }

    fun observe(index: Int, offset: Int, count: Int, newestId: String?) {
        val contentChanged = count != seenCount || newestId != seenNewest
        seenCount = count
        seenNewest = newestId
        if (keepPaused(index, offset)) return
        following = when {
            index == 0 && offset <= nearBottomPx -> true
            // Индекс сдвинула вставка (или удаление), а не жест: низ остаётся низом.
            contentChanged -> following
            else -> false
        }
    }

    /**
     * Прокрутка закончилась (жест, флинг, колесо) — решение по тому, где лента встала.
     *
     * Это главный сигнал: `isScrollInProgress` поднимается и от касания, и от колеса
     * (замерено), а на приход контента не реагирует вовсе. В отличие от [observe],
     * здесь нечему сбиться: переокно истории или переподключение в момент жеста больше
     * не могут «защитать» уход от низа как приход контента (жалоба 2026-10-17:
     * «на телефоне при получении сообщения идёт автоскролл вниз»).
     */
    fun settle(index: Int, offset: Int) {
        if (keepPaused(index, offset)) return
        following = index == 0 && offset <= nearBottomPx
    }
}
