param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationCore

$outputDirectory = Join-Path $RepositoryRoot 'docs\images'
$compactPath = Join-Path $outputDirectory 'app-compact.png'
$insightsPath = Join-Path $outputDirectory 'app-insights.png'
$previewPath = Join-Path $outputDirectory 'social-preview.png'
$gifPath = Join-Path $outputDirectory 'demo.gif'

foreach ($requiredPath in @($compactPath, $insightsPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Missing source image: $requiredPath"
    }
}

$background = [System.Drawing.Color]::FromArgb(255, 12, 17, 25)
$panel = [System.Drawing.Color]::FromArgb(255, 24, 32, 45)
$panelBorder = [System.Drawing.Color]::FromArgb(255, 48, 62, 82)
$white = [System.Drawing.Color]::FromArgb(255, 247, 249, 252)
$muted = [System.Drawing.Color]::FromArgb(255, 165, 187, 216)
$cyan = [System.Drawing.Color]::FromArgb(255, 103, 209, 255)
$amber = [System.Drawing.Color]::FromArgb(255, 255, 190, 72)
$green = [System.Drawing.Color]::FromArgb(255, 111, 220, 164)

function New-Canvas {
    param([int]$Width, [int]$Height)

    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $graphics.Clear($background)
    return @($bitmap, $graphics)
}

function Draw-Text {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string]$Text,
        [float]$X,
        [float]$Y,
        [float]$Size,
        [System.Drawing.Color]$Color,
        [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular,
        [float]$MaxWidth = 0
    )

    $font = [System.Drawing.Font]::new('Segoe UI', $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new($Color)
    try {
        if ($MaxWidth -gt 0) {
            $format = [System.Drawing.StringFormat]::new()
            $format.Trimming = [System.Drawing.StringTrimming]::Word
            $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
            try {
                $Graphics.DrawString($Text, $font, $brush, [System.Drawing.RectangleF]::new($X, $Y, $MaxWidth, 300), $format)
            }
            finally {
                $format.Dispose()
            }
        }
        else {
            $Graphics.DrawString($Text, $font, $brush, $X, $Y)
        }
    }
    finally {
        $brush.Dispose()
        $font.Dispose()
    }
}

function Draw-Panel {
    param(
        [System.Drawing.Graphics]$Graphics,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height
    )

    $fill = [System.Drawing.SolidBrush]::new($panel)
    $border = [System.Drawing.Pen]::new($panelBorder, 2)
    try {
        $Graphics.FillRectangle($fill, $X, $Y, $Width, $Height)
        $Graphics.DrawRectangle($border, $X, $Y, $Width, $Height)
    }
    finally {
        $border.Dispose()
        $fill.Dispose()
    }
}

function Draw-CroppedImage {
    param(
        [System.Drawing.Graphics]$Graphics,
        [System.Drawing.Image]$Image,
        [System.Drawing.RectangleF]$Destination,
        [System.Drawing.RectangleF]$Source
    )

    $Graphics.DrawImage(
        $Image,
        $Destination,
        $Source,
        [System.Drawing.GraphicsUnit]::Pixel
    )
}

function Save-Png {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function New-DemoFrame {
    param(
        [int]$Index,
        [System.Drawing.Image]$Compact,
        [System.Drawing.Image]$Insights
    )

    $canvas = New-Canvas -Width 960 -Height 540
    $bitmap = $canvas[0]
    $graphics = $canvas[1]

    Draw-Text $graphics 'CODEX CLAUDE USAGE' 48 32 19 $cyan ([System.Drawing.FontStyle]::Bold)

    switch ($Index) {
        1 {
            Draw-Text $graphics 'Two AI coding limits.' 48 92 43 $white ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'One small Windows tray view.' 48 146 28 $muted
            Draw-Text $graphics 'Codex CLI + Claude Code' 48 458 23 $green ([System.Drawing.FontStyle]::Bold)
            Draw-Panel $graphics 560 25 350 490
            Draw-CroppedImage $graphics $Compact ([System.Drawing.RectangleF]::new(582, 43, 306, 454)) ([System.Drawing.RectangleF]::new(0, 0, $Compact.Width, $Compact.Height))
        }
        2 {
            Draw-Text $graphics 'Will it run out before reset?' 48 78 42 $white ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'Forecast the exhaustion window and confidence.' 48 132 24 $muted
            Draw-Panel $graphics 48 190 864 302
            Draw-CroppedImage $graphics $Insights ([System.Drawing.RectangleF]::new(66, 208, 828, 266)) ([System.Drawing.RectangleF]::new(30, 345, 1168, 620))
            Draw-Text $graphics 'FORECAST' 765 45 18 $amber ([System.Drawing.FontStyle]::Bold)
        }
        3 {
            Draw-Text $graphics 'Catch unusual usage spikes.' 48 78 42 $white ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'Compare today with your own recent baseline.' 48 132 24 $muted
            Draw-Panel $graphics 48 190 864 302
            Draw-CroppedImage $graphics $Insights ([System.Drawing.RectangleF]::new(66, 208, 828, 266)) ([System.Drawing.RectangleF]::new(28, 1010, 1172, 520))
            Draw-Text $graphics 'DETECT' 785 45 18 $amber ([System.Drawing.FontStyle]::Bold)
        }
        4 {
            Draw-Text $graphics 'Know what to change next.' 48 78 42 $white ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'Slow down, review repetition, or switch models.' 48 132 24 $muted
            Draw-Panel $graphics 48 190 864 302
            Draw-CroppedImage $graphics $Insights ([System.Drawing.RectangleF]::new(66, 228, 828, 226)) ([System.Drawing.RectangleF]::new(28, 1550, 1172, 335))
            Draw-Text $graphics 'ACT' 820 45 18 $amber ([System.Drawing.FontStyle]::Bold)
        }
        5 {
            Draw-Text $graphics 'Local by design.' 48 96 48 $white ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'No product telemetry.' 48 176 27 $green ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'No local server.' 48 218 27 $green ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'No always-on collection CLI.' 48 260 27 $green ([System.Drawing.FontStyle]::Bold)
            Draw-Text $graphics 'Windows beta on GitHub' 48 440 25 $cyan ([System.Drawing.FontStyle]::Bold)
            Draw-Panel $graphics 610 74 250 360
            Draw-CroppedImage $graphics $Compact ([System.Drawing.RectangleF]::new(626, 90, 218, 328)) ([System.Drawing.RectangleF]::new(0, 0, $Compact.Width, $Compact.Height))
        }
    }

    $graphics.Dispose()
    return $bitmap
}

function Convert-PngToGifFrame {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [UInt16]$Delay
    )

    $pngStream = [System.IO.MemoryStream]::new()
    $Bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngStream.Position = 0
    $decoder = [System.Windows.Media.Imaging.PngBitmapDecoder]::new(
        $pngStream,
        [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
        [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    )
    $metadata = [System.Windows.Media.Imaging.BitmapMetadata]::new('gif')
    $metadata.SetQuery('/grctlext/delay', $Delay)
    $metadata.SetQuery('/grctlext/disposal', [byte]2)
    $frame = [System.Windows.Media.Imaging.BitmapFrame]::Create(
        $decoder.Frames[0],
        $decoder.Frames[0].Thumbnail,
        $metadata,
        $decoder.Frames[0].ColorContexts
    )
    $pngStream.Dispose()
    return $frame
}

function Add-GifAnimationMetadata {
    param(
        [string]$Path,
        [UInt16]$Delay
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 14 -or [System.Text.Encoding]::ASCII.GetString($bytes, 0, 3) -ne 'GIF') {
        throw "Not a GIF file: $Path"
    }

    $packed = $bytes[10]
    $globalColorTableSize = 0
    if (($packed -band 0x80) -ne 0) {
        $globalColorTableSize = 3 * [Math]::Pow(2, (($packed -band 0x07) + 1))
    }

    $offset = 13 + [int]$globalColorTableSize
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write($bytes, 0, $offset)

        # Netscape application extension: loop forever.
        $writer.Write([byte[]]@(
            0x21, 0xFF, 0x0B,
            0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30,
            0x03, 0x01, 0x00, 0x00, 0x00
        ))

        while ($offset -lt $bytes.Length) {
            $marker = $bytes[$offset]
            switch ($marker) {
                0x2C {
                    # Graphic control extension: disposal=2, no transparency, delay in 1/100 seconds.
                    $writer.Write([byte[]]@(
                        0x21, 0xF9, 0x04, 0x08,
                        [byte]($Delay -band 0xFF),
                        [byte](($Delay -shr 8) -band 0xFF),
                        0x00, 0x00
                    ))

                    $descriptorStart = $offset
                    $descriptorLength = 10
                    $writer.Write($bytes, $offset, $descriptorLength)
                    $offset += $descriptorLength

                    $imagePacked = $bytes[$descriptorStart + 9]
                    if (($imagePacked -band 0x80) -ne 0) {
                        $localColorTableSize = 3 * [Math]::Pow(2, (($imagePacked -band 0x07) + 1))
                        $writer.Write($bytes, $offset, [int]$localColorTableSize)
                        $offset += [int]$localColorTableSize
                    }

                    # LZW minimum code size.
                    $writer.Write($bytes[$offset])
                    $offset += 1

                    # Image data sub-blocks.
                    while ($true) {
                        $blockSize = [int]$bytes[$offset]
                        $writer.Write($bytes[$offset])
                        $offset += 1
                        if ($blockSize -eq 0) {
                            break
                        }
                        $writer.Write($bytes, $offset, $blockSize)
                        $offset += $blockSize
                    }
                }
                0x21 {
                    $extensionLabel = $bytes[$offset + 1]
                    $preserveExtension = $extensionLabel -ne 0xF9
                    # Replace existing zero-delay graphic controls; preserve other extensions.
                    if ($preserveExtension) {
                        $writer.Write($bytes, $offset, 2)
                    }
                    $offset += 2
                    while ($true) {
                        $blockSize = [int]$bytes[$offset]
                        if ($preserveExtension) {
                            $writer.Write($bytes[$offset])
                        }
                        $offset += 1
                        if ($blockSize -eq 0) {
                            break
                        }
                        if ($preserveExtension) {
                            $writer.Write($bytes, $offset, $blockSize)
                        }
                        $offset += $blockSize
                    }
                }
                0x3B {
                    $writer.Write($bytes[$offset])
                    $offset += 1
                }
                default {
                    throw "Unexpected GIF block marker 0x$($marker.ToString('X2')) at byte $offset"
                }
            }
        }

        $writer.Flush()
        [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$compact = [System.Drawing.Image]::FromFile($compactPath)
$insights = [System.Drawing.Image]::FromFile($insightsPath)

try {
    $previewCanvas = New-Canvas -Width 1280 -Height 640
    $preview = $previewCanvas[0]
    $previewGraphics = $previewCanvas[1]
    try {
        $accentBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, 103, 209, 255))
        try {
            $previewGraphics.FillEllipse($accentBrush, -220, 360, 760, 420)
        }
        finally {
            $accentBrush.Dispose()
        }

        Draw-Text $previewGraphics 'CODEX CLAUDE USAGE' 72 64 22 $cyan ([System.Drawing.FontStyle]::Bold)
        Draw-Text $previewGraphics 'Will your AI coding limit' 72 130 55 $white ([System.Drawing.FontStyle]::Bold)
        Draw-Text $previewGraphics 'run out before reset?' 72 195 55 $white ([System.Drawing.FontStyle]::Bold)
        Draw-Text $previewGraphics 'Forecast exhaustion | Detect spikes | Decide what to change' 76 292 25 $muted
        Draw-Text $previewGraphics 'Codex CLI + Claude Code' 76 492 25 $green ([System.Drawing.FontStyle]::Bold)
        Draw-Text $previewGraphics 'Local Windows tray app' 76 532 23 $muted

        Draw-Panel $previewGraphics 886 35 332 570
        Draw-CroppedImage $previewGraphics $Compact ([System.Drawing.RectangleF]::new(910, 56, 284, 526)) ([System.Drawing.RectangleF]::new(0, 0, $compact.Width, $compact.Height))
        Save-Png $preview $previewPath
    }
    finally {
        $previewGraphics.Dispose()
        $preview.Dispose()
    }

    $encoder = [System.Windows.Media.Imaging.GifBitmapEncoder]::new()
    $frames = [System.Collections.Generic.List[System.Drawing.Bitmap]]::new()
    try {
        foreach ($index in 1..5) {
            $demoFrame = New-DemoFrame -Index $index -Compact $compact -Insights $insights
            $frames.Add($demoFrame)
            $encoder.Frames.Add((Convert-PngToGifFrame -Bitmap $demoFrame -Delay 300))
        }

        $gifStream = [System.IO.File]::Open(
            $gifPath,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $encoder.Save($gifStream)
        }
        finally {
            $gifStream.Dispose()
        }
        Add-GifAnimationMetadata -Path $gifPath -Delay 300
    }
    finally {
        foreach ($frameBitmap in $frames) {
            $frameBitmap.Dispose()
        }
    }
}
finally {
    $insights.Dispose()
    $compact.Dispose()
}

Write-Output "Created $previewPath"
Write-Output "Created $gifPath"
