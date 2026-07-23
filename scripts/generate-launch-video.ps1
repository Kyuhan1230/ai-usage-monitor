param(
    [string]$FfmpegPath,
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "docs\images\walkthrough-45s.mp4"
}

if ([string]::IsNullOrWhiteSpace($FfmpegPath)) {
    $ffmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($null -eq $ffmpegCommand) {
        throw "ffmpeg was not found. Pass -FfmpegPath with an ffmpeg executable."
    }
    $FfmpegPath = $ffmpegCommand.Source
}

$resolvedFfmpeg = (Resolve-Path -LiteralPath $FfmpegPath).Path
$resolvedOutputDirectory = (Resolve-Path -LiteralPath (Split-Path -Parent $OutputPath)).Path
$resolvedOutput = Join-Path $resolvedOutputDirectory (Split-Path -Leaf $OutputPath)

$temporaryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetTempPath()) ("ai-usage-launch-video-" + [guid]::NewGuid().ToString("N")))
)
$systemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

if (-not $temporaryRoot.StartsWith($systemTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create temporary video files outside the system temp directory."
}

New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

function New-RoundedRectanglePath {
    param(
        [System.Drawing.RectangleF]$Rectangle,
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-FittedImage {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string]$ImagePath,
        [System.Drawing.RectangleF]$Bounds
    )

    $image = [System.Drawing.Image]::FromFile($ImagePath)
    try {
        $scale = [Math]::Min($Bounds.Width / $image.Width, $Bounds.Height / $image.Height)
        $width = [float]($image.Width * $scale)
        $height = [float]($image.Height * $scale)
        $x = [float]($Bounds.X + (($Bounds.Width - $width) / 2))
        $y = [float]($Bounds.Y + (($Bounds.Height - $height) / 2))

        $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(80, 0, 0, 0))
        $panelBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 18, 28, 42))
        $panelPath = New-RoundedRectanglePath -Rectangle ([System.Drawing.RectangleF]::new($Bounds.X, $Bounds.Y, $Bounds.Width, $Bounds.Height)) -Radius 22
        try {
            $Graphics.FillRectangle($shadowBrush, $Bounds.X + 12, $Bounds.Y + 14, $Bounds.Width, $Bounds.Height)
            $Graphics.FillPath($panelBrush, $panelPath)
            $Graphics.SetClip($panelPath)
            $Graphics.DrawImage($image, $x, $y, $width, $height)
            $Graphics.ResetClip()
        }
        finally {
            $panelPath.Dispose()
            $panelBrush.Dispose()
            $shadowBrush.Dispose()
        }
    }
    finally {
        $image.Dispose()
    }
}

function New-VideoScene {
    param(
        [string]$Path,
        [string]$Eyebrow,
        [string]$Title,
        [string]$Body,
        [string]$ImagePath,
        [string]$Footer
    )

    $bitmap = [System.Drawing.Bitmap]::new(1280, 720)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    $eyebrowFont = [System.Drawing.Font]::new("Segoe UI Semibold", 18, [System.Drawing.FontStyle]::Bold)
    $titleFont = [System.Drawing.Font]::new("Segoe UI Semibold", 42, [System.Drawing.FontStyle]::Bold)
    $bodyFont = [System.Drawing.Font]::new("Segoe UI", 22, [System.Drawing.FontStyle]::Regular)
    $footerFont = [System.Drawing.Font]::new("Segoe UI Semibold", 16, [System.Drawing.FontStyle]::Bold)

    $eyebrowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 68, 219, 156))
    $titleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $bodyBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 190, 203, 221))
    $footerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 126, 145, 170))
    $accentBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 39, 190, 134))

    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $graphics.Clear([System.Drawing.Color]::FromArgb(255, 8, 15, 27))

        $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Rectangle]::new(0, 0, 1280, 720),
            [System.Drawing.Color]::FromArgb(255, 8, 15, 27),
            [System.Drawing.Color]::FromArgb(255, 19, 42, 57),
            18
        )
        try {
            $graphics.FillRectangle($gradient, 0, 0, 1280, 720)
        }
        finally {
            $gradient.Dispose()
        }

        $graphics.FillRectangle($accentBrush, 64, 58, 54, 5)
        $graphics.DrawString($Eyebrow, $eyebrowFont, $eyebrowBrush, 64, 78)

        $textWidth = if ([string]::IsNullOrWhiteSpace($ImagePath)) { 1060 } else { 500 }
        $titleRectangle = [System.Drawing.RectangleF]::new(64, 125, $textWidth, 220)
        $bodyRectangle = [System.Drawing.RectangleF]::new(64, 355, $textWidth, 210)

        $graphics.DrawString($Title, $titleFont, $titleBrush, $titleRectangle)
        $graphics.DrawString($Body, $bodyFont, $bodyBrush, $bodyRectangle)

        if (-not [string]::IsNullOrWhiteSpace($ImagePath)) {
            Draw-FittedImage -Graphics $graphics -ImagePath $ImagePath -Bounds ([System.Drawing.RectangleF]::new(610, 100, 606, 520))
        }

        $graphics.DrawString($Footer, $footerFont, $footerBrush, 64, 660)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $accentBrush.Dispose()
        $footerBrush.Dispose()
        $bodyBrush.Dispose()
        $titleBrush.Dispose()
        $eyebrowBrush.Dispose()
        $footerFont.Dispose()
        $bodyFont.Dispose()
        $titleFont.Dispose()
        $eyebrowFont.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

try {
    $forecastFrame = Join-Path $temporaryRoot "demo-forecast.png"
    $spikeFrame = Join-Path $temporaryRoot "demo-spike.png"
    $actionFrame = Join-Path $temporaryRoot "demo-action.png"
    $demoGif = Join-Path $repoRoot "docs\images\demo.gif"

    foreach ($frame in @(
        @{ Time = 1; Path = $forecastFrame },
        @{ Time = 4; Path = $spikeFrame },
        @{ Time = 7; Path = $actionFrame }
    )) {
        & $resolvedFfmpeg `
            -hide_banner `
            -loglevel error `
            -y `
            -ss $frame.Time `
            -i $demoGif `
            -frames:v 1 `
            $frame.Path

        if ($LASTEXITCODE -ne 0) {
            throw "ffmpeg failed while extracting a demo frame."
        }
    }

    $scenes = @(
        @{
            File = "scene-01.png"
            Duration = 5
            Eyebrow = "THE QUESTION"
            Title = "Will your AI coding limit survive until reset?"
            Body = "A remaining percentage does not tell you whether today's pace is sustainable."
            Image = ""
            Footer = "Codex CLI + Claude Code | Local Windows tray app"
        },
        @{
            File = "scene-02.png"
            Duration = 10
            Eyebrow = "ONE COMPACT VIEW"
            Title = "See Codex and Claude at a glance."
            Body = "Either provider is enough. Using both puts their remaining quota and reset timing in one place."
            Image = (Join-Path $repoRoot "docs\images\app-compact.png")
            Footer = "Compact mode stays available from the system tray"
        },
        @{
            File = "scene-03.png"
            Duration = 10
            Eyebrow = "FORECAST"
            Title = "Know whether exhaustion comes first."
            Body = "The app estimates an exhaustion window, compares it with reset, and shows confidence instead of pretending the forecast is exact."
            Image = $forecastFrame
            Footer = "Forecast window + reset comparison + confidence"
        },
        @{
            File = "scene-04.png"
            Duration = 5
            Eyebrow = "DETECT"
            Title = "Catch unusual usage spikes."
            Body = "Compare today with your own recent baseline instead of a generic threshold."
            Image = $spikeFrame
            Footer = "Personal baseline + quota and token spike detection"
        },
        @{
            File = "scene-05.png"
            Duration = 5
            Eyebrow = "ACT"
            Title = "Know what to change next."
            Body = "See the required slowdown, repetitive-work check, or lower-cost model suggestion."
            Image = $actionFrame
            Footer = "Slow down, review repetition, or switch models"
        },
        @{
            File = "scene-06.png"
            Duration = 10
            Eyebrow = "LOCAL WINDOWS BETA"
            Title = "Your usage stays local."
            Body = "No developer telemetry. Verify the release SHA-256. The current installer is unsigned, so SmartScreen may show Unknown publisher."
            Image = (Join-Path $repoRoot "assets\codex-claude-usage.png")
            Footer = "github.com/Kyuhan1230/ai-usage-monitor"
        }
    )

    foreach ($scene in $scenes) {
        New-VideoScene `
            -Path (Join-Path $temporaryRoot $scene.File) `
            -Eyebrow $scene.Eyebrow `
            -Title $scene.Title `
            -Body $scene.Body `
            -ImagePath $scene.Image `
            -Footer $scene.Footer
    }

    $concatLines = [System.Collections.Generic.List[string]]::new()
    foreach ($scene in $scenes) {
        $scenePath = (Join-Path $temporaryRoot $scene.File).Replace("\", "/").Replace("'", "'\''")
        $concatLines.Add("file '$scenePath'")
        $concatLines.Add("duration $($scene.Duration)")
    }
    $lastScenePath = (Join-Path $temporaryRoot $scenes[-1].File).Replace("\", "/").Replace("'", "'\''")
    $concatLines.Add("file '$lastScenePath'")

    $concatPath = Join-Path $temporaryRoot "scenes.txt"
    [System.IO.File]::WriteAllLines($concatPath, $concatLines, [System.Text.UTF8Encoding]::new($false))

    & $resolvedFfmpeg `
        -hide_banner `
        -loglevel error `
        -y `
        -f concat `
        -safe 0 `
        -i $concatPath `
        -vf "fps=30,format=yuv420p" `
        -c:v libx264 `
        -preset medium `
        -crf 21 `
        -movflags "+faststart" `
        -t 45 `
        $resolvedOutput

    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed with exit code $LASTEXITCODE."
    }

    $outputInfo = Get-Item -LiteralPath $resolvedOutput
    Write-Output "Created $($outputInfo.FullName)"
    Write-Output "Bytes: $($outputInfo.Length)"
}
finally {
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    if (
        (Test-Path -LiteralPath $resolvedTemporaryRoot) -and
        $resolvedTemporaryRoot.StartsWith($systemTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        $resolvedTemporaryRoot -ne $systemTempRoot
    ) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}
