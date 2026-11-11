# Builds Make Video Small and packages it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#
# Result, in dist\:
#   Make Video Small\                 the program with its engine folder (runs as it is)
#   MakeVideoSmall-<version>-setup.exe   an installer, when NSIS is available
#   MakeVideoSmall-<version>-portable.zip   otherwise
#
# The installer bundles whatever is in engine\. Run scripts\fetch-ffmpeg.ps1
# first if the installer should carry its own ffmpeg; without it the app uses
# an ffmpeg that is already installed on the PC.

param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Select-String -Path "$root\app\Cargo.toml" -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value

if (-not $SkipBuild) {
    cargo build --release -p make-video-small
    if ($LASTEXITCODE -ne 0) { throw 'The build failed.' }
}
$exe = "$root\target\release\make-video-small.exe"
if (-not (Test-Path $exe)) { throw "Not found: $exe" }

# Stage the files exactly as they are installed.
$stage = "$root\dist\Make Video Small"
New-Item -ItemType Directory -Force "$stage\engine" | Out-Null
# Skip the program if it has not changed: the staged copy may be running.
$staged = "$stage\make-video-small.exe"
if (-not (Test-Path $staged) -or (Get-FileHash $exe).Hash -ne (Get-FileHash $staged).Hash) {
    Copy-Item $exe $staged -Force
}
# /MIR keeps the staged engine folder identical to engine\ (minus notes for developers).
robocopy "$root\engine" "$stage\engine" /MIR /XF README.md *.pth /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Copying the engine folder failed.' }

if (-not (Test-Path "$stage\engine\ffmpeg.exe")) {
    Write-Warning 'engine\ffmpeg.exe is missing, so this package relies on an ffmpeg installed on the PC. Run scripts\fetch-ffmpeg.ps1 to bundle one.'
}

$makensis = @(
    (Get-Command makensis -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
    "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "$env:ProgramFiles\NSIS\makensis.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($makensis) {
    $out = "$root\dist\MakeVideoSmall-$version-setup.exe"
    & $makensis /V2 "/DVERSION=$version" "/DSRC=$stage" "/DOUT=$out" "$root\installer\installer.nsi"
    if ($LASTEXITCODE -ne 0) { throw 'Building the installer failed.' }
} else {
    Write-Warning 'NSIS was not found (winget install NSIS.NSIS), so a zip is made instead of an installer.'
    $out = "$root\dist\MakeVideoSmall-$version-portable.zip"
    Compress-Archive -Path "$stage\*" -DestinationPath $out -Force
}

$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "Packaged: $out ($mb MB)"
Write-Host "Program folder: $stage"
