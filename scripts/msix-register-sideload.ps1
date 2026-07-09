<#
.SYNOPSIS
    REQ-0155 §2 — one-shot sideload register for the paid-tier MSIX build.

.DESCRIPTION
    Owner-facing script that takes the working tree from "source code
    ready" to "the paid-tier build is registered on this box and appears
    in the Start menu".  Replaces the pre-REQ-0155 manual sequence
    (build -> package -> extract .appx -> Remove-AppxPackage -> Add-AppxPackage
    -Register) with a single command.

    Manual steps the owner still owns:

      1. Enable Developer Mode (Windows settings only; a script can't flip
         this security toggle).  The script hard-fails with a clear message
         when Developer Mode is off — it will not attempt to enable it.

      2. Launch MOJIOKO from the Start menu after this script reports
         success.  Launching `app\MOJIOKO.exe` directly bypasses the MSIX
         container and reports as the free tier — Start menu launch is
         what makes `isPackagedAsMsix()` return true.

    Ships alongside `electron-builder-appx.yml` (the sideload cert config)
    and consumes the packaged .appx it produces.  The store-target config
    (`electron-builder-appx-store.yml`) is untouched — Partner Center
    submissions still go through the unsigned Store pipeline.

.PARAMETER SkipBuild
    Skip the electron-vite + electron-builder packaging step.  Useful
    when the .appx on disk already reflects the current tree (e.g. a
    fresh CI-produced artefact).  When set, the script demands that
    `dist-appx/MOJIOKO <version>.appx` already exists.

.PARAMETER Version
    Optional explicit version stamp; defaults to the `version` field in
    package.json.  The script uses this only to locate `MOJIOKO <version>.appx`
    on disk.

.EXAMPLE
    # Full one-shot from source:
    powershell -ExecutionPolicy Bypass -File scripts\msix-register-sideload.ps1

.EXAMPLE
    # Re-register from an existing .appx without rebuilding:
    powershell -ExecutionPolicy Bypass -File scripts\msix-register-sideload.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$Version
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail {
    param([string]$Message)
    Write-Host ""
    Write-Host "!! $Message" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 0. Preflight: Developer Mode must be on
# ---------------------------------------------------------------------------
# The AppModelUnlock registry key is Windows' own record of the Developer Mode
# toggle in Settings > For developers.  `Add-AppxPackage -Register` refuses
# a manifest that isn't signed by a trusted publisher when this is off — the
# error is a generic 0x80073CF0 which is much less helpful than a targeted
# preflight, hence the check here.
Write-Step "Preflight: Developer Mode"
$devModeKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$devModeVal = $null
if (Test-Path $devModeKey) {
    try { $devModeVal = (Get-ItemProperty -Path $devModeKey -Name 'AllowDevelopmentWithoutDevLicense' -ErrorAction Stop).AllowDevelopmentWithoutDevLicense } catch {}
}
if ($devModeVal -ne 1) {
    Fail @"
Developer Mode is not enabled.  Register requires it because the sideload
package is signed with a self-signed cert whose publisher (CN=brightryo)
is not in the machine's TrustedPeople store.

Enable it via:
  Settings -> Privacy & security -> For developers -> Developer Mode = On

Then re-run this script.
"@
}
Write-Host "   OK — AppModelUnlock\AllowDevelopmentWithoutDevLicense = 1"

# ---------------------------------------------------------------------------
# 1. Locate the repo root (script is expected under <root>/scripts/)
# ---------------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
Set-Location $repoRoot

# Read version from package.json when the caller did not provide one.
if (-not $Version) {
    $pkgRaw = Get-Content -Raw -Path (Join-Path $repoRoot 'package.json')
    $pkg = $pkgRaw | ConvertFrom-Json
    $Version = $pkg.version
}
Write-Host "   Repo    : $repoRoot"
Write-Host "   Version : $Version"

$appxPath = Join-Path $repoRoot "dist-appx\MOJIOKO $Version.appx"
$loosePath = Join-Path $repoRoot "dist-appx\MOJIOKO-$Version-loose"
$manifestPath = Join-Path $loosePath 'AppxManifest.xml'

# ---------------------------------------------------------------------------
# 2. Build + package (or skip when the .appx is fresh enough)
# ---------------------------------------------------------------------------
if ($SkipBuild) {
    Write-Step "Skipping build (-SkipBuild)"
    if (-not (Test-Path $appxPath)) {
        Fail "-SkipBuild requested but $appxPath does not exist."
    }
} else {
    Write-Step "1/4 electron-vite build (renderer + main)"
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "npm run build failed (exit $LASTEXITCODE)." }

    Write-Step "2/4 electron-builder appx package"
    # Signing is INTENTIONALLY expected to fail on Windows 11 build 26200
    # with the electron-builder-cached signtool 4.00 (REQ-0154 §Part D).
    # The .appx itself is written to disk BEFORE the sign step runs, so
    # we swallow the sign-step failure and fall through to loose-file
    # registration — which does not need a valid Authenticode signature.
    $builderExitCode = 0
    try {
        npx electron-builder --win appx --config electron-builder-appx.yml
        $builderExitCode = $LASTEXITCODE
    } catch {
        $builderExitCode = 1
    }
    if (-not (Test-Path $appxPath)) {
        Fail "electron-builder did not produce $appxPath (exit $builderExitCode)."
    }
    if ($builderExitCode -ne 0) {
        Write-Host "   Note: signtool signing step failed (expected on this OS build)."
        Write-Host "         The unsigned .appx exists; falling through to loose-file registration."
    }
}

# ---------------------------------------------------------------------------
# 3. Loose-file expansion of the .appx
# ---------------------------------------------------------------------------
Write-Step "3/4 Expand .appx to loose-file layout"
if (Test-Path $loosePath) {
    Remove-Item $loosePath -Recurse -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($appxPath, $loosePath)
if (-not (Test-Path $manifestPath)) {
    Fail "Extracted layout at $loosePath is missing AppxManifest.xml."
}

# REQ-0156 §1 — decode Open Packaging Conventions filename escaping.
#
# An .appx is a ZIP that also conforms to OPC / ECMA-376, which mandates
# percent-encoding for characters outside a small "safe" set inside part
# names (`%` becomes `%25`, `+` becomes `%2B`, etc.).  When Windows
# installs an .appx via `Add-AppxPackage <path>.appx` it decodes those
# during unpack because the AppX runtime knows the OPC rules.
#
# `[System.IO.Compression.ZipFile]::ExtractToDirectory` is a plain ZIP
# extractor — it writes each ZIP entry name verbatim to disk, so a
# part named "libstdc%2B%2B-6-<hash>.dll" (which is PyAV's C++ runtime
# with two literal `+` in its filename) lands as `libstdc%2B%2B-6-<hash>.dll`
# instead of `libstdc++-6-<hash>.dll`.  PyAV then fails to LoadLibrary
# its own C++ runtime, `import av` throws, and faster-whisper's import
# chain surfaces as "faster-whisper is not installed" in the sidecar.
# This bug ONLY affects loose-file sideload registration — Store-
# distributed .appx installs go through the AppX runtime which decodes
# correctly.  See REQ-0156 RES §2 for the full trace.
#
# Fix: walk the extracted tree bottom-up and rename any file / folder
# whose name matches `%XX` (hex-pair escapes) to its decoded form
# using `[uri]::UnescapeDataString`.  Bottom-up so a nested rename never
# invalidates its parent's still-in-flight path.
$escapePattern = '%[0-9A-Fa-f]{2}'
$decodeTargets = Get-ChildItem -Path $loosePath -Recurse -Force |
    Where-Object { $_.Name -match $escapePattern } |
    Sort-Object { $_.FullName.Length } -Descending

foreach ($item in $decodeTargets) {
    $decoded = [uri]::UnescapeDataString($item.Name)
    if ($decoded -eq $item.Name) { continue }
    Rename-Item -LiteralPath $item.FullName -NewName $decoded -Force
    Write-Host "   OPC-decoded: $($item.Name) -> $decoded"
}
if ($decodeTargets.Count -eq 0) {
    Write-Host "   (no OPC-encoded filenames found — nothing to decode)"
}

Write-Host "   Layout at $loosePath"

# ---------------------------------------------------------------------------
# 4. Remove existing registration (if any) then Add-AppxPackage -Register
# ---------------------------------------------------------------------------
Write-Step "4/4 Register sideload MSIX (Add-AppxPackage -Register)"

# `brightryo.MOJIOKO` is the Identity.Name from electron-builder-appx.yml —
# the appx:identityName field.  Any registered package with that Name gets
# removed first so a repeat run always lands on the freshly-extracted files.
$pkgName = 'brightryo.MOJIOKO'
$existing = Get-AppxPackage -Name $pkgName -ErrorAction SilentlyContinue
if ($existing) {
    foreach ($p in $existing) {
        Write-Host "   Removing existing registration: $($p.PackageFullName)"
        Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop
    }
} else {
    Write-Host "   No prior $pkgName registration."
}

Add-AppxPackage -Register $manifestPath -ErrorAction Stop
Write-Host "   Registered successfully."

# Confirm the new registration surfaced.
$after = Get-AppxPackage -Name $pkgName -ErrorAction SilentlyContinue
if (-not $after) {
    Fail "Registration reported success but Get-AppxPackage returned no result."
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "MSIX sideload registered." -ForegroundColor Green
Write-Host "  PackageFullName : $($after.PackageFullName)"
Write-Host "  InstallLocation : $($after.InstallLocation)"
Write-Host ""
Write-Host "Next step (owner):"
Write-Host "  Open the Start menu, search for 'MOJIOKO', and launch it."
Write-Host "  Do NOT launch app\MOJIOKO.exe directly — that runs outside the"
Write-Host "  MSIX container and reports as the free tier."
