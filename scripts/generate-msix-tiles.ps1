# REQ-090 — generate the 4 PNG tiles that electron-builder maps into the MSIX
# package's `assets\` directory.  Replaces the vendor SampleAppx placeholders
# that triggered the Microsoft Store 10.1.1.11 "On Device Tiles" rejection.
#
# Source     : docs/images/icon.png  (256x256, opaque #23C55E + black M)
# Output dir : build/appx/
# Files      : StoreLogo.png (50x50)
#              Square44x44Logo.png (44x44)
#              Square150x150Logo.png (150x150)
#              Wide310x150Logo.png (310x150 — M scaled to 150x150 centred,
#                                   green pads the 80 px each side)
#
# Background : solid #23C55E (Tailwind green-500) to match the source icon
#              and the BackgroundColor we now set in the appx manifest.
#
# Why PowerShell + System.Drawing rather than `sharp` / ImageMagick:
#   - Ships with Windows out of the box (no extra `npm i` / `winget` step
#     for the contributor running the script).
#   - HighQualityBicubic + HighQuality smoothing produces clean downsamples
#     at these target sizes (the largest sample is 150 px, well below the
#     256 px source so no upscale is involved for the M itself).
#
# Re-runnable: every call overwrites the existing PNGs in place.

[CmdletBinding()]
param(
    [string]$Source,
    [string]$OutDir
)

Add-Type -AssemblyName System.Drawing

# Resolve defaults relative to this script's own directory so the script
# can be run from anywhere, but the call sites can also override either
# path explicitly.  $PSScriptRoot is the documented modern way to do
# this; we fall back to $MyInvocation for the older WPS 5.1 path where
# $PSScriptRoot is occasionally empty when launched via `powershell -File`.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$repoRoot  = Split-Path -Parent $scriptDir
if (-not $Source) { $Source = Join-Path $repoRoot 'docs/images/icon.png' }
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'build/appx' }

# Solid green that matches docs/images/icon.png's painted background.
# Sampled in REQ-090 investigation; identical to Tailwind's `green-500`
# constant used throughout the renderer's design system.
$bgColor = [System.Drawing.Color]::FromArgb(255, 0x23, 0xC5, 0x5E)

if (-not (Test-Path $Source)) {
    throw "Source icon not found: $Source"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$srcImg = [System.Drawing.Image]::FromFile($Source)
try {
    function Save-Square([int]$size, [string]$name) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.Clear($bgColor)
            $g.DrawImage($srcImg, 0, 0, $size, $size)
            $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $g.Dispose()
            $bmp.Dispose()
        }
    }

    function Save-Wide([string]$name) {
        # 310x150 canvas; the M is drawn at 150x150 centred, so it only
        # shrinks (max 0.59x from the 256 source) and never upscales.
        # The 80 px on each side are filled with solid green.
        $w = 310
        $h = 150
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.Clear($bgColor)
            $logoSize = 150
            $logoX = [int](($w - $logoSize) / 2)   # = 80
            $g.DrawImage($srcImg, $logoX, 0, $logoSize, $logoSize)
            $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $g.Dispose()
            $bmp.Dispose()
        }
    }

    Save-Square  50 'StoreLogo.png'
    Save-Square  44 'Square44x44Logo.png'
    Save-Square 150 'Square150x150Logo.png'
    Save-Wide       'Wide310x150Logo.png'
} finally {
    $srcImg.Dispose()
}

Write-Output "Generated MSIX tiles in $OutDir :"
Get-ChildItem $OutDir -Filter '*.png' | ForEach-Object {
    $img = [System.Drawing.Image]::FromFile($_.FullName)
    Write-Output ("  {0,-26} {1,4}x{2,-4}  {3,6} bytes" -f $_.Name, $img.Width, $img.Height, $_.Length)
    $img.Dispose()
}
