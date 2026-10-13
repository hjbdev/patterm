# Windows x64 per-user install. Run again to select the latest release.
# irm https://github.com/hjbdev/patterm/releases/latest/download/install.ps1 | iex
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Patterm'),
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw 'The Windows package currently supports x64 only.' }
# Windows PowerShell 5.1 can otherwise negotiate an obsolete TLS version.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/hjbdev/patterm/releases/latest' -Headers @{ 'User-Agent' = 'Patterm installer' }
if ($release.tag_name -notmatch '^v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$') { throw 'Invalid release version.' }
$version = $Matches[1]
$name = "patterm-$version-windows-x64"
$asset = @($release.assets | Where-Object { $_.name -eq "$name.zip" })
$checksum = @($release.assets | Where-Object { $_.name -eq "$name.zip.sha256" })
if ($asset.Count -ne 1 -or $checksum.Count -ne 1) { throw "Release $version has no Windows x64 package and checksum." }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('patterm-install-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $temp | Out-Null
    $zip = Join-Path $temp "$name.zip"
    $hashFile = Join-Path $temp 'checksum.txt'
    Write-Host "Downloading Patterm $version for Windows x64..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset[0].browser_download_url -OutFile $zip
    Invoke-WebRequest -UseBasicParsing -Uri $checksum[0].browser_download_url -OutFile $hashFile
    $hashText = (Get-Content -LiteralPath $hashFile -Raw).Trim()
    if ($hashText -notmatch ('^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape("$name.zip") + '$')) { throw 'Invalid package checksum file.' }
    $expected = $Matches[1]
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) { throw 'Package checksum verification failed.' }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName.Replace('\', '/')
            if (-not $entryName.StartsWith("$name/", [StringComparison]::Ordinal) -or
                $entryName.Contains(':') -or $entryName -match '(^|/)[^/]*[. ](/|$)' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw "Unsafe archive entry: $entryName"
            }
        }
    } finally { $archive.Dispose() }
    $extract = Join-Path $temp 'extracted'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
    $package = Join-Path $extract $name
    foreach ($file in @('Patterm.cmd', 'electron/electron.exe', 'resources/native/patterm-terminal-core.exe', 'BUILD')) {
        if (-not (Test-Path -LiteralPath (Join-Path $package $file) -PathType Leaf)) { throw "Package is missing $file." }
    }
    if ((Get-Content -LiteralPath (Join-Path $package 'BUILD')) -notcontains "version=$version") { throw 'Package version does not match the release.' }
    $versions = Join-Path $InstallRoot 'versions'
    $destination = Join-Path $versions $version
    New-Item -ItemType Directory -Path $versions -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
        if (-not (Test-Path -LiteralPath (Join-Path $destination 'Patterm.cmd') -PathType Leaf)) { throw "Incomplete install at $destination; remove it and retry." }
    } else {
        Move-Item -LiteralPath $package -Destination $destination
    }
    $bin = Join-Path $InstallRoot 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $launcher = "@echo off`r`ncall `"%~dp0..\versions\$version\Patterm.cmd`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $bin 'patterm.cmd'), $launcher, [Text.Encoding]::ASCII)
    if (-not $NoPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';') -notcontains $bin) {
            $updatedPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $bin } else { $bin }
            [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
        }
        if (($env:Path -split ';') -notcontains $bin) { $env:Path += ';' + $bin }
    }
    Write-Host "Patterm $version installed in $destination."
    Write-Host 'Run patterm to open the desktop app. Install and sign into your agent CLIs separately.'
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
