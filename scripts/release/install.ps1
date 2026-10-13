# Windows x64 per-user install. Run again to select the latest release.
# irm https://github.com/hjbdev/patterm/releases/latest/download/install.ps1 | iex
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Patterm'),
    [string]$StartMenuDirectory = [Environment]::GetFolderPath('Programs'),
    [switch]$NoPath,
    [string]$Version,
    [switch]$AllowDowngrade
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw 'The Windows package currently supports x64 only.' }
# Windows PowerShell 5.1 can otherwise negotiate an obsolete TLS version.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$requestedVersion = $null
if ($Version) {
    $requestedVersion = $Version.TrimStart('v')
    if ($requestedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid requested version.' }
}
$releaseUrl = if ($requestedVersion) { "https://api.github.com/repos/hjbdev/patterm/releases/tags/v$requestedVersion" } else { 'https://api.github.com/repos/hjbdev/patterm/releases/latest' }
$release = Invoke-RestMethod -Uri $releaseUrl -Headers @{ 'User-Agent' = 'Patterm installer' }
if ($release.tag_name -notmatch '^v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$') { throw 'Invalid release version.' }
$releaseVersion = $Matches[1]
if ($requestedVersion -and $requestedVersion -ne $releaseVersion) { throw 'Release version does not match the requested version.' }
$version = $releaseVersion
$name = "patterm-$version-windows-x64"
$asset = @($release.assets | Where-Object { $_.name -eq "$name.zip" })
$checksum = @($release.assets | Where-Object { $_.name -eq "$name.zip.sha256" })
if ($asset.Count -ne 1 -or $checksum.Count -ne 1) { throw "Release $version has no Windows x64 package and checksum." }

function Test-VersionOlder([string]$Left, [string]$Right) {
    $a = $Left -split '-', 2
    $b = $Right -split '-', 2
    $core = ([version]$a[0]).CompareTo([version]$b[0])
    if ($core -ne 0) { return $core -lt 0 }
    if ($a.Count -eq 1) { return $false }
    if ($b.Count -eq 1) { return $true }
    $ap = $a[1].Split('.')
    $bp = $b[1].Split('.')
    for ($i = 0; $i -lt [Math]::Min($ap.Count, $bp.Count); $i++) {
        if ($ap[$i] -ceq $bp[$i]) { continue }
        $an = $ap[$i] -match '^\d+$'
        $bn = $bp[$i] -match '^\d+$'
        if ($an -and $bn) { return [decimal]$ap[$i] -lt [decimal]$bp[$i] }
        if ($an -ne $bn) { return $an }
        return [string]::CompareOrdinal($ap[$i], $bp[$i]) -lt 0
    }
    return $ap.Count -lt $bp.Count
}
function Assert-AppStopped {
    $prefix = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'")) {
        if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Patterm is running. Quit Patterm, then rerun this installer to update.'
        }
    }
}
$lock = $null
$pendingLauncher = $null

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
    Assert-AppStopped
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    try {
        $lock = [IO.File]::Open((Join-Path $InstallRoot '.install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw 'Another Patterm installer is running; retry when it finishes.' }
    $launcherPath = Join-Path $InstallRoot 'bin/patterm.cmd'
    if (Test-Path -LiteralPath $launcherPath) {
        $previous = Get-Content -LiteralPath $launcherPath -Raw
        if ($previous -notmatch 'versions\\(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\\Patterm\.cmd') { throw 'The existing launcher has an unrecognised version; update it manually.' }
        $installedVersion = $Matches[1]
        if ((Test-VersionOlder $version $installedVersion) -and -not $AllowDowngrade) {
            throw "Patterm $installedVersion is newer than $version. Use -AllowDowngrade only with a matching database backup."
        }
    }
    $versions = Join-Path $InstallRoot 'versions'
    $destination = Join-Path $versions $version
    New-Item -ItemType Directory -Path $versions -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
        foreach ($file in @('Patterm.cmd', 'electron/electron.exe', 'resources/native/patterm-terminal-core.exe', 'BUILD')) {
            if (-not (Test-Path -LiteralPath (Join-Path $destination $file) -PathType Leaf)) { throw "Incomplete install at $destination; remove it and retry." }
        }
        if ((Get-Content -LiteralPath (Join-Path $destination 'BUILD')) -notcontains "version=$version") { throw "Invalid installed version at $destination." }
    } else {
        Move-Item -LiteralPath $package -Destination $destination
    }
    $bin = Join-Path $InstallRoot 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $launcher = "@echo off`r`ncall `"%~dp0..\versions\$version\Patterm.cmd`" %*`r`n"
    $pendingLauncher = Join-Path $bin ('.patterm-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($pendingLauncher, $launcher, [Text.Encoding]::ASCII)

    # The stable launcher and icon keep Start menu and pinned shortcuts working
    # when a later install selects another version. Older zips have no .ico yet.
    $packageIcon = Join-Path $destination 'dist/renderer/icons/icon.ico'
    $icon = Join-Path $destination 'electron/electron.exe'
    if (Test-Path -LiteralPath $packageIcon -PathType Leaf) {
        $icon = Join-Path $InstallRoot 'patterm.ico'
        Copy-Item -LiteralPath $packageIcon -Destination $icon -Force
    }
    New-Item -ItemType Directory -Path $StartMenuDirectory -Force | Out-Null
    $shortcutPath = Join-Path $StartMenuDirectory 'Patterm.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    try {
        $shortcut.TargetPath = Join-Path $bin 'patterm.cmd'
        $shortcut.WorkingDirectory = $InstallRoot
        $shortcut.Description = 'Patterm agent workbench'
        $shortcut.IconLocation = "$icon,0"
        $shortcut.WindowStyle = 7 # Minimise the brief command launcher, not the app.
        $shortcut.Save()
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
    # WScript.Shell cannot set the identity Electron uses for taskbar grouping
    # and notifications. Write the shortcut's native property store instead.
    if (-not ('PattermShortcut' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PattermShortcut {
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariant {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Value;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr context, uint flags, ref Guid iid, out IPropertyStore store);

    public static void SetAppId(string path, string appId) {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store)); // GPS_READWRITE
        var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 }; // PKEY_AppUserModel_ID
        var value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni(appId) }; // VT_LPWSTR
        try {
            Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
            Marshal.ThrowExceptionForHR(store.Commit());
        } finally {
            Marshal.FreeCoTaskMem(value.Value);
            Marshal.ReleaseComObject(store);
        }
    }
}
'@
    }
    [PattermShortcut]::SetAppId($shortcutPath, 'Patterm.Desktop')

    if (-not $NoPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';') -notcontains $bin) {
            $updatedPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $bin } else { $bin }
            [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
        }
        if (($env:Path -split ';') -notcontains $bin) { $env:Path += ';' + $bin }
    }
    # Switch only after installation, shortcut and PATH setup all succeeded.
    # Replace is atomic: a failed update leaves the previous launcher usable.
    Assert-AppStopped
    if (Test-Path -LiteralPath $launcherPath) { [IO.File]::Replace($pendingLauncher, $launcherPath, (Join-Path $bin 'patterm.previous.cmd')) }
    else { [IO.File]::Move($pendingLauncher, $launcherPath) }
    $pendingLauncher = $null
    Write-Host "Patterm $version installed in $destination."
    Write-Host 'Open Patterm from the Start menu or run patterm. Install and sign into your agent CLIs separately.'
} finally {
    if ($pendingLauncher -and (Test-Path -LiteralPath $pendingLauncher)) { Remove-Item -LiteralPath $pendingLauncher -Force }
    if ($lock) { $lock.Dispose() }
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
