package ru.arny.taskbridge.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// Line icons drawn from path data (24×24, 2px stroke, round caps), so the app
// needs no icon library. Icon() tints them with the current content color.

private fun lineIcon(name: String, vararg paths: String, filled: Boolean = false): ImageVector {
    val builder = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    for (d in paths) {
        builder.addPath(
            pathData = addPathNodes(d),
            fill = if (filled) SolidColor(Color.Black) else null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }
    return builder.build()
}

object AppIcons {
    val Back = lineIcon("back", "M19 12H5", "M12 19l-7-7 7-7")
    val Send = lineIcon("send", "M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z")
    val Stop = lineIcon("stop", "M7 7h10v10H7z", filled = true)
    val Add = lineIcon("add", "M12 5v14", "M5 12h14")
    val Attach = lineIcon("attach", "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48")
    val More = lineIcon("more", "M12 5h.01", "M12 12h.01", "M12 19h.01")
    val Settings = lineIcon("settings", "M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6")
    val Search = lineIcon("search", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.35-4.35")
    val Close = lineIcon("close", "M18 6L6 18", "M6 6l12 12")
    val Copy = lineIcon("copy", "M9 9h11v11H9z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1")
    val Refresh = lineIcon("refresh", "M23 4v6h-6", "M1 20v-6h6", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10", "M1 14l4.64 4.36A9 9 0 0 0 20.49 15")
    val Edit = lineIcon("edit", "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z")
    val Delete = lineIcon("delete", "M3 6h18", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", "M10 11v6", "M14 11v6", "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2")
    val Fork = lineIcon("fork", "M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9")
    val ChevronDown = lineIcon("chevronDown", "M6 9l6 6 6-6")
    val ChevronUp = lineIcon("chevronUp", "M18 15l-6-6-6 6")
    val ChevronLeft = lineIcon("chevronLeft", "M15 18l-6-6 6-6")
    val ChevronRight = lineIcon("chevronRight", "M9 18l6-6-6-6")
    val Check = lineIcon("check", "M20 6L9 17l-5-5")
    val Clock = lineIcon("clock", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2")
    val Alert = lineIcon("alert", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01")
    val Tool = lineIcon("tool", "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z")
    val Terminal = lineIcon("terminal", "M4 17l6-6-6-6", "M12 19h8")
    val Spark = lineIcon("spark", "M13 2L3 14h9l-1 8 10-12h-9l1-8z")
    val Play = lineIcon("play", "M5 3l14 9-14 9V3z")
    val Offline = lineIcon("offline", "M1 1l22 22", "M16.72 11.06A10.94 10.94 0 0 1 19 12.55", "M5 12.55a10.94 10.94 0 0 1 5.17-2.39", "M10.71 5.05A16 16 0 0 1 22.58 9", "M1.42 9a15.91 15.91 0 0 1 4.7-2.88", "M8.53 16.11a6 6 0 0 1 6.95 0", "M12 20h.01")
    val Computer = lineIcon("computer", "M2 3h20v14H2z", "M8 21h8", "M12 17v4")
    val Folder = lineIcon("folder", "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z")
    val ArrowDown = lineIcon("arrowDown", "M12 5v14", "M19 12l-7 7-7-7")
    val File = lineIcon("file", "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M13 2v7h7")
    val Layers = lineIcon("layers", "M12 2L2 7l10 5 10-5-10-5z", "M2 17l10 5 10-5", "M2 12l10 5 10-5")
    val Logout = lineIcon("logout", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9")
    val Chat = lineIcon("chat", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")
    val Shield = lineIcon("shield", "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z")
    val Queue = lineIcon("queue", "M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01")
    val Eraser = lineIcon("eraser", "M20 20H9l-6-6 10-10 7 7-6 6", "M6 11l7 7")
    val Sun = lineIcon("sun", "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 1v2", "M12 21v2", "M4.22 4.22l1.42 1.42", "M18.36 18.36l1.42 1.42", "M1 12h2", "M21 12h2", "M4.22 19.78l1.42-1.42", "M18.36 5.64l1.42-1.42")
    val Moon = lineIcon("moon", "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z")
}
