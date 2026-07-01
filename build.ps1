<#
.SYNOPSIS
    Packs the Partner Center Alternative Names extension into a versioned zip.

.DESCRIPTION
    Chrome extensions here are plain JS with no bundle step, so "building" just
    means collecting the runtime files (and nothing else — no .git, .plan, or
    the build script itself) into a zip whose contents sit at the archive root,
    which is what "Load unpacked" expects and what the Chrome Web Store accepts.

    The version is read from manifest.json, so the output name always matches
    the shipped version: dist\partner-center-alternative-names-<version>.zip

.EXAMPLE
    pwsh ./build.ps1
#>
[CmdletBinding()]
param(
    # Output directory for the packed zip.
    [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Run relative to this script regardless of the caller's working directory.
$root = $PSScriptRoot
Push-Location $root
try {
    # Files/folders that make up the shipped extension. Anything not listed
    # here (build.ps1, .plan, .git, README, etc.) is intentionally excluded.
    $include = @(
        "manifest.json",
        "background.js",
        "content.js",
        "search-inject.js",
        "icons"
    )

    # Fail loudly if the extension is missing a declared file.
    $missing = $include | Where-Object { -not (Test-Path $_) }
    if ($missing) {
        throw "Missing required extension file(s): $($missing -join ', ')"
    }

    # Read the version straight from the manifest so the zip name can't drift.
    $manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
    $version = $manifest.version
    $name = $manifest.name
    if (-not $version) { throw "manifest.json has no 'version' field." }

    if (-not (Test-Path $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    }

    $zipPath = Join-Path $OutDir "partner-center-alternative-names-$version.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    # Compress-Archive would nest a top-level folder in the zip; the manifest
    # must be at the archive root instead. So stage into a temp dir and zip its
    # *contents*.
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("pcaltnames-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        foreach ($item in $include) {
            Copy-Item -Path $item -Destination $staging -Recurse -Force
        }
        Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
    }
    finally {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    }

    $sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host "Packed '$name' v$version -> $zipPath ($sizeKb KB)" -ForegroundColor Green
    Write-Host "Files: $($include -join ', ')"
}
finally {
    Pop-Location
}
