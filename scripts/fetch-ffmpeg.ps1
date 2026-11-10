# Downloads ffmpeg + ffprobe (shared build) into engine/ so they can be bundled
# with the app. The binaries are GPL-licensed and are not stored in git.
#
#   npm run fetch-ffmpeg            # skip if already present
#   npm run fetch-ffmpeg -- -Force  # download again

param(
    [switch]$Force,
    [string]$Asset = "ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$engine = Join-Path (Split-Path -Parent $PSScriptRoot) "engine"
$ffmpeg = Join-Path $engine "ffmpeg.exe"

if ((Test-Path $ffmpeg) -and -not $Force) {
    Write-Host "ffmpeg is already in $engine (use -Force to replace it)."
    exit 0
}

$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$Asset"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("mvs-ffmpeg-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null
$zip = Join-Path $work "ffmpeg.zip"

try {
    Write-Host "Downloading $Asset ..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    Write-Host "Extracting ..."
    Expand-Archive -Path $zip -DestinationPath $work -Force
    $bin = Get-ChildItem -Path $work -Recurse -Directory -Filter "bin" | Select-Object -First 1
    if (-not $bin) { throw "The archive does not contain a bin folder." }

    New-Item -ItemType Directory -Force $engine | Out-Null
    # Remove DLLs from an earlier ffmpeg version so they cannot be mixed.
    Get-ChildItem -Path $engine -Filter "*.dll" |
        Where-Object { $_.Name -match '^(av|sw|postproc)' } |
        Remove-Item -Force

    $copied = 0
    Get-ChildItem -Path $bin.FullName -File |
        Where-Object { $_.Name -in @("ffmpeg.exe", "ffprobe.exe") -or $_.Extension -eq ".dll" } |
        ForEach-Object {
            Copy-Item $_.FullName -Destination $engine -Force
            $copied++
        }

    $license = Get-ChildItem -Path $work -Recurse -File -Filter "LICENSE.txt" | Select-Object -First 1
    if ($license) { Copy-Item $license.FullName -Destination (Join-Path $engine "FFMPEG-LICENSE.txt") -Force }

    Write-Host "Copied $copied files into $engine"
    & $ffmpeg -hide_banner -version | Select-Object -First 1
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
