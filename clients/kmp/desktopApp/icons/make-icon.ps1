# Renders web/icon.svg (dark rounded square, violet four-point star) into
# TaskBridge.ico (16..256, PNG entries) and icon.png for the window.
# Run from this folder: powershell -File make-icon.ps1
Add-Type -AssemblyName System.Drawing

function Render([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $k = $s / 128.0
    $r = 26 * $k * 2
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bg.AddArc(0, 0, $r, $r, 180, 90); $bg.AddArc($s - $r, 0, $r, $r, 270, 90)
    $bg.AddArc($s - $r, $s - $r, $r, $r, 0, 90); $bg.AddArc(0, $s - $r, $r, $r, 90, 90); $bg.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#080b14'))), $bg)
    $pts = @(64,24, 74,54, 104,64, 74,74, 64,104, 54,74, 24,64, 54,54)
    $points = for ($i = 0; $i -lt $pts.Length; $i += 2) { New-Object System.Drawing.PointF ([float]($pts[$i] * $k)), ([float]($pts[$i + 1] * $k)) }
    # Small sizes get a thicker stroke so the star survives at 16 px.
    $width = [Math]::Max(9 * $k, 1.6)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#a78bfa')), ([float]$width)
    $pen.LineJoin = 'Round'
    $g.DrawPolygon($pen, [System.Drawing.PointF[]]$points)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($s in $sizes) { ,(Render $s) }
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $data = $images[$i]
    $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$data.Length); $w.Write([UInt32]$offset)
    $offset += $data.Length
}
foreach ($data in $images) { $w.Write($data) }
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'TaskBridge.ico'), $out.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot '..\src\main\resources\icon.png'), (Render 256))
