param([string]$PackageDirectory)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$installer = Join-Path $PSScriptRoot '../scripts/release/install.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('patterm-installer-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$originalPath = $env:Path
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$global:pattermInstallerFixture = @{ Version = '1.2.3'; BadChecksum = $false; MissingAsset = $false; Directory = $fixture }
function Invoke-RestMethod {
    param($Uri, $Headers)
    $assets = @(
        [pscustomobject]@{ name = "patterm-$($global:pattermInstallerFixture.Version)-windows-x64.zip"; browser_download_url = 'https://example.invalid/package' },
        [pscustomobject]@{ name = "patterm-$($global:pattermInstallerFixture.Version)-windows-x64.zip.sha256"; browser_download_url = 'https://example.invalid/checksum' }
    )
    if ($global:pattermInstallerFixture.MissingAsset) { $assets = @() }
    return [pscustomobject]@{ tag_name = "v$($global:pattermInstallerFixture.Version)"; assets = $assets }
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    if ($Uri -eq 'https://example.invalid/package') { Copy-Item (Join-Path $global:pattermInstallerFixture.Directory 'package.zip') $OutFile }
    else {
        $hash = (Get-FileHash (Join-Path $global:pattermInstallerFixture.Directory 'package.zip')).Hash
        if ($global:pattermInstallerFixture.BadChecksum) { $hash = '0' * 64 }
        [IO.File]::WriteAllText($OutFile, "$hash  patterm-$($global:pattermInstallerFixture.Version)-windows-x64.zip`n")
    }
}
function Make-Package([switch]$Unsafe) {
    $zip = Join-Path $fixture 'package.zip'
    if (Test-Path $zip) { Remove-Item $zip }
    $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = @{
            'Patterm.cmd' = "@echo off`r`necho launched:%*`r`n"
            'BUILD' = "version=1.2.3`ncommit=synthetic`n"
            'electron/electron.exe' = 'synthetic test file'
            'resources/native/patterm-terminal-core.exe' = 'synthetic test file'
        }
        if ($Unsafe) { $files['../escaped.txt'] = 'must never be extracted' }
        foreach ($file in $files.Keys) {
            $entry = $archive.CreateEntry("patterm-1.2.3-windows-x64/$file")
            $writer = New-Object IO.StreamWriter($entry.Open())
            try { $writer.Write($files[$file]) } finally { $writer.Dispose() }
        }
    } finally { $archive.Dispose() }
}
function Expect-Failure($Root, $Message) {
    $failed = $false
    try { & $installer -InstallRoot $Root -NoPath } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        $failed = $true
    }
    if (-not $failed) { throw "Expected failure: $Message" }
    if (Test-Path $Root) { throw 'A failed validation created an installation.' }
}
try {
    Make-Package
    $root = Join-Path $fixture 'install with spaces'
    & $installer -InstallRoot $root -NoPath
    $launcher = Join-Path $root 'bin/patterm.cmd'
    $result = & $launcher 'hello world'
    if ($result -ne 'launched:"hello world"' -and $result -ne 'launched:hello world') { throw "Launcher did not forward arguments: $result" }
    & $installer -InstallRoot $root -NoPath
    if ($env:Path -ne $originalPath -or [Environment]::GetEnvironmentVariable('Path', 'User') -ne $userPath) { throw 'Isolated install changed PATH.' }
    $global:pattermInstallerFixture.BadChecksum = $true
    Expect-Failure (Join-Path $fixture 'bad-hash') 'checksum verification failed'
    $global:pattermInstallerFixture.BadChecksum = $false
    Make-Package -Unsafe
    Expect-Failure (Join-Path $fixture 'unsafe-archive') 'Unsafe archive entry'
    if (Test-Path (Join-Path $fixture 'escaped.txt')) { throw 'Archive escaped its staging directory.' }
    $global:pattermInstallerFixture.MissingAsset = $true
    Expect-Failure (Join-Path $fixture 'missing-asset') 'no Windows x64 package'
    if ($PackageDirectory) {
        $packages = @(Get-ChildItem -LiteralPath $PackageDirectory -Filter 'patterm-*-windows-x64.zip')
        if ($packages.Count -ne 1 -or $packages[0].Name -notmatch '^patterm-(.+)-windows-x64\.zip$') { throw 'Expected one built Windows package.' }
        $global:pattermInstallerFixture.Version = $Matches[1]
        $global:pattermInstallerFixture.MissingAsset = $false
        Copy-Item -LiteralPath $packages[0].FullName -Destination (Join-Path $fixture 'package.zip') -Force
        & $installer -InstallRoot (Join-Path $fixture 'real package with spaces') -NoPath
        Write-Host 'Actual built Windows package installation: PASS'
    }
    Write-Host 'Windows installer smoke: installation, spaced paths, launcher arguments, repeat install, PATH isolation, bad checksum, unsafe archive and missing asset PASS'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Variable pattermInstallerFixture -Scope Global
}
