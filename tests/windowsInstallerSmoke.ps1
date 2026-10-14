param([string]$PackageDirectory)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$installer = Join-Path $PSScriptRoot '../scripts/release/install.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('patterm-installer-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$originalPath = $env:Path
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$startMenu = Join-Path $fixture 'Start menu with spaces'
$global:pattermInstallerFixture = @{ Version = '1.2.3'; BadChecksum = $false; MissingAsset = $false; Directory = $fixture }
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($global:pattermInstallerFixture.RunningApp) { return [pscustomobject]@{ ExecutablePath = $global:pattermInstallerFixture.RunningApp } }
    return @()
}
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
function Make-Package([switch]$Unsafe, [switch]$Legacy) {
    $zip = Join-Path $fixture 'package.zip'
    if (Test-Path $zip) { Remove-Item $zip }
    $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = @{
            'Patterm.cmd' = "@echo off`r`necho launched:%*`r`n"
            'BUILD' = "version=$($global:pattermInstallerFixture.Version)`ncommit=synthetic`n"
            'electron/electron.exe' = 'synthetic test file'
            'resources/native/patterm-terminal-core.exe' = 'synthetic test file'
        }
        if ($Unsafe) { $files['../escaped.txt'] = 'must never be extracted' }
        foreach ($file in $files.Keys) {
            $entry = $archive.CreateEntry("patterm-$($global:pattermInstallerFixture.Version)-windows-x64/$file")
            $writer = New-Object IO.StreamWriter($entry.Open())
            try { $writer.Write($files[$file]) } finally { $writer.Dispose() }
        }
        if (-not $Legacy) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,
                (Join-Path $PSScriptRoot '../public/icons/icon.ico'),
                "patterm-$($global:pattermInstallerFixture.Version)-windows-x64/dist/renderer/icons/icon.ico")
        }
    } finally { $archive.Dispose() }
}
function Expect-Failure($Root, $Message) {
    $failed = $false
    try { & $installer -InstallRoot $Root -StartMenuDirectory $startMenu -NoPath } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        $failed = $true
    }
    if (-not $failed) { throw "Expected failure: $Message" }
    if (Test-Path $Root) { throw 'A failed validation created an installation.' }
}
function Assert-Shortcut($Root, $Icon) {
    $Icon = [IO.Path]::GetFullPath($Icon)
    if (-not (Test-Path -LiteralPath $Icon -PathType Leaf)) { throw 'Shortcut icon file is missing.' }
    $shortcutPath = Join-Path $startMenu 'Patterm.lnk'
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'Installer did not create a Start menu entry.' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    try {
        if ($shortcut.TargetPath -ne (Join-Path $Root 'bin/patterm.cmd')) { throw 'Shortcut does not use the stable launcher.' }
        if ($shortcut.WorkingDirectory -ne $Root) { throw 'Shortcut working directory is incorrect.' }
        if ($shortcut.IconLocation -ne "$Icon,0") { throw "Shortcut icon is incorrect: $($shortcut.IconLocation)" }
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.NameSpace($startMenu)
    $item = $folder.ParseName('Patterm.lnk')
    try {
        if ($item.ExtendedProperty('System.AppUserModel.ID') -ne 'Patterm.Desktop') { throw 'Shortcut identity does not match Electron.' }
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($folder)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
    if (@(Get-ChildItem -LiteralPath $startMenu -Filter '*.lnk').Count -ne 1) { throw 'Repeat installs created duplicate shortcuts.' }
}
try {
    Make-Package
    $root = Join-Path $fixture 'install with spaces'
    & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath
    Assert-Shortcut $root (Join-Path $root 'patterm.ico')
    $launcher = Join-Path $root 'bin/patterm.cmd'
    $result = & $launcher 'hello world'
    if ($result -ne 'launched:"hello world"' -and $result -ne 'launched:hello world') { throw "Launcher did not forward arguments: $result" }
    & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath
    Assert-Shortcut $root (Join-Path $root 'patterm.ico')
    $global:pattermInstallerFixture.Version = '1.2.4'
    Make-Package
    & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath
    Assert-Shortcut $root (Join-Path $root 'patterm.ico')
    if ((Get-Content -LiteralPath $launcher -Raw) -notlike '*versions\1.2.4\Patterm.cmd*') { throw 'Upgrade did not select the new version.' }
    $previousLauncher = Get-Content -LiteralPath $launcher -Raw
    function Expect-UpdateFailure([string]$Message, [string]$Menu = $startMenu) {
        $failed = $false
        try { & $installer -InstallRoot $root -StartMenuDirectory $Menu -NoPath } catch {
            if ($_.Exception.Message -notlike "*$Message*") { throw }
            $failed = $true
        }
        if (-not $failed) { throw "Expected update failure: $Message" }
        if ((Get-Content -LiteralPath $launcher -Raw) -cne $previousLauncher) { throw 'A failed update changed the launcher.' }
        if ((& $launcher 'still usable') -notlike 'launched:*') { throw 'Previous launcher stopped working.' }
    }
    $global:pattermInstallerFixture.Version = '1.2.3'
    Make-Package
    Expect-UpdateFailure 'newer than'
    $global:pattermInstallerFixture.Version = '1.2.5'
    Make-Package
    $global:pattermInstallerFixture.RunningApp = Join-Path $root 'versions/1.2.4/electron/electron.exe'
    Expect-UpdateFailure 'Patterm is running'
    $global:pattermInstallerFixture.RunningApp = $null
    # The in-app updater pins the checksum from the signed release manifest.
    $failed = $false
    try { & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath -Sha256 ('f' * 64) } catch {
        if ($_.Exception.Message -notlike '*signed release manifest*') { throw }
        $failed = $true
    }
    if (-not $failed -or (Get-Content -LiteralPath $launcher -Raw) -cne $previousLauncher) { throw 'A package that does not match the manifest checksum was installed.' }
    $heldLock = [IO.File]::Open((Join-Path $root '.install.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Expect-UpdateFailure 'Another Patterm installer' } finally { $heldLock.Dispose() }
    $blockedMenu = Join-Path $fixture 'not a directory'
    [IO.File]::WriteAllText($blockedMenu, 'blocked')
    # A late setup failure must leave the old version selected.
    $failed = $false
    try { & $installer -InstallRoot $root -StartMenuDirectory $blockedMenu -NoPath } catch { $failed = $true }
    if (-not $failed -or (Get-Content -LiteralPath $launcher -Raw) -cne $previousLauncher) { throw 'A late setup failure switched versions.' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $root 'bin') -Filter '*.tmp').Count) { throw 'Failed update left a pending launcher.' }
    & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath
    if ((Get-Content -LiteralPath $launcher -Raw) -notlike '*versions\1.2.5\Patterm.cmd*') { throw 'Retry did not finish the update.' }
    foreach ($nextVersion in @('1.2.6-beta.2', '1.2.6-beta.10', '1.2.6')) {
        $global:pattermInstallerFixture.Version = $nextVersion
        Make-Package
        & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath -Version $nextVersion
    }
    $previousLauncher = Get-Content -LiteralPath $launcher -Raw
    $global:pattermInstallerFixture.Version = '1.2.6-beta.10'
    Make-Package
    Expect-UpdateFailure 'newer than'
    & $installer -InstallRoot $root -StartMenuDirectory $startMenu -NoPath -AllowDowngrade
    if ((Get-Content -LiteralPath $launcher -Raw) -notlike '*versions\1.2.6-beta.10\Patterm.cmd*') { throw 'Explicit downgrade was not selected.' }
    if ($env:Path -ne $originalPath -or [Environment]::GetEnvironmentVariable('Path', 'User') -ne $userPath) { throw 'Isolated install changed PATH.' }
    $global:pattermInstallerFixture.Version = '1.2.4'
    Make-Package
    $global:pattermInstallerFixture.BadChecksum = $true
    Expect-Failure (Join-Path $fixture 'bad-hash') 'checksum verification failed'
    $global:pattermInstallerFixture.BadChecksum = $false
    Make-Package -Unsafe
    Expect-Failure (Join-Path $fixture 'unsafe-archive') 'Unsafe archive entry'
    if (Test-Path (Join-Path $fixture 'escaped.txt')) { throw 'Archive escaped its staging directory.' }
    Make-Package -Legacy
    $legacyRoot = Join-Path $fixture 'legacy package'
    & $installer -InstallRoot $legacyRoot -StartMenuDirectory $startMenu -NoPath
    Assert-Shortcut $legacyRoot (Join-Path $legacyRoot 'versions/1.2.4/electron/electron.exe')
    $global:pattermInstallerFixture.MissingAsset = $true
    Expect-Failure (Join-Path $fixture 'missing-asset') 'no Windows x64 package'
    if ($PackageDirectory) {
        $packages = @(Get-ChildItem -LiteralPath $PackageDirectory -Filter 'patterm-*-windows-x64.zip')
        if ($packages.Count -ne 1 -or $packages[0].Name -notmatch '^patterm-(.+)-windows-x64\.zip$') { throw 'Expected one built Windows package.' }
        $global:pattermInstallerFixture.Version = $Matches[1]
        $global:pattermInstallerFixture.MissingAsset = $false
        Copy-Item -LiteralPath $packages[0].FullName -Destination (Join-Path $fixture 'package.zip') -Force
        $realRoot = Join-Path $fixture 'real package with spaces'
        & $installer -InstallRoot $realRoot -StartMenuDirectory $startMenu -NoPath
        Assert-Shortcut $realRoot (Join-Path $realRoot 'patterm.ico')
        Write-Host 'Actual built Windows package installation: PASS'
    }
    Write-Host 'Windows installer smoke: installation, Start menu entry, icon, application identity, spaced paths, launcher arguments, repeat install, upgrade, legacy package, PATH isolation, bad checksum, unsafe archive and missing asset PASS'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Variable pattermInstallerFixture -Scope Global
}
