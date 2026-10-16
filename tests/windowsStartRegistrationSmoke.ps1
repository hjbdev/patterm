# Opt-in only: this test uses the disposable GitHub-hosted VM's real Start menu.
param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Start registration smoke requires a disposable GitHub-hosted Windows runner.' }
$programs = [Environment]::GetFolderPath('Programs')
foreach ($name in @('Patterm.lnk', 'Electron.lnk')) {
    if (Test-Path -LiteralPath (Join-Path $programs $name)) { throw "Refusing to overwrite an existing $name in the real Start menu." }
}
$probeId = 'Patterm.StartSmoke.' + [Guid]::NewGuid().ToString('N')
$installRoot = Join-Path $Directory 'toast installation'
$installation = Join-Path $installRoot 'versions/new'
New-Item -ItemType Directory -Path $installation -Force | Out-Null
$runtime = Join-Path $installation 'electron'
Copy-Item -LiteralPath (Split-Path $Executable) -Destination $runtime -Recurse
$probeExe = Join-Path $runtime 'Patterm.exe'
New-Item -ItemType Directory -Path (Join-Path $installation 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path (Split-Path (Split-Path $Executable)) 'scripts/install.ps1') -Destination (Join-Path $installation 'scripts/install.ps1')
# Model an old updater: it unpacked the new package but left its old toast link.
$legacyPath = Join-Path $programs 'Electron.lnk'
$legacyTarget = Join-Path $installRoot 'versions/0.2.8/electron/Patterm.exe'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($legacyPath)
try { $link.TargetPath = $legacyTarget; $link.Save() } finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
[PattermShortcut]::SetAppId($legacyPath, 'Patterm.Desktop')
$entryDirectory = Join-Path $installation 'dist/main/desktop/main'
New-Item -ItemType Directory -Path $entryDirectory -Force | Out-Null
$config = @{ appId = $probeId; data = (Join-Path $Directory 'toast user data'); root = $installation; legacy = $legacyPath } | ConvertTo-Json -Compress
$main = @"
const { app, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const config = $config;
if (process.env.PATTERM_DESKTOP_RESOURCES !== path.join(config.root, 'resources') || process.cwd() !== config.root) {
  throw new Error('Direct executable bootstrap did not configure the installation');
}
app.setPath('userData', config.data);
app.setAppUserModelId(config.appId);
let toast;
app.whenReady().then(async () => {
  const deadline = Date.now() + 15000;
  while (fs.existsSync(config.legacy) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (fs.existsSync(config.legacy)) throw new Error('Old updater shortcut was not repaired on launch');
  toast = new Notification({ title: 'Patterm registration test', body: 'Disposable CI test' });
  toast.show();
  setTimeout(() => app.quit(), 1000);
}).catch(error => { console.error(error); app.exit(1); });
"@
[IO.File]::WriteAllText((Join-Path $entryDirectory 'main.js'), $main)
$originalRunAsNode = $env:ELECTRON_RUN_AS_NODE
$process = $null
try {
    $env:ELECTRON_RUN_AS_NODE = $null
    $process = Start-Process -FilePath $probeExe -ArgumentList '--disable-gpu' -WorkingDirectory $runtime -PassThru
    if (-not $process.WaitForExit(30000)) { throw 'Toast registration probe did not exit.' }
    if ($process.ExitCode -ne 0) { throw "Toast registration probe exited with $($process.ExitCode)." }
    if (Test-Path -LiteralPath $legacyPath) { throw 'Legacy Electron shortcut survived new app launch.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $entries = @(Get-StartApps | Where-Object AppID -EQ $probeId)
        if ($entries.Count -gt 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($entries.Count -ne 1 -or $entries[0].Name -ne 'Patterm') {
        throw "Windows registered the wrong Start app name: $($entries | ConvertTo-Json -Compress)"
    }
    Write-Host 'Native Windows Start app display name: Patterm; old updater shortcut repaired PASS'
} finally {
    $env:ELECTRON_RUN_AS_NODE = $originalRunAsNode
    if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    foreach ($name in @('Patterm.lnk', 'Electron.lnk')) {
        $shell = $folder = $item = $null
        try {
            $shell = New-Object -ComObject Shell.Application
            $folder = $shell.NameSpace($programs)
            $item = $folder.ParseName($name)
            if ($item -and ($item.ExtendedProperty('System.AppUserModel.ID') -eq $probeId -or ($name -eq 'Electron.lnk' -and $item.ExtendedProperty('System.AppUserModel.ID') -eq 'Patterm.Desktop' -and $item.ExtendedProperty('System.Link.TargetParsingPath') -eq $legacyTarget))) {
                Remove-Item -LiteralPath (Join-Path $programs $name) -Force
            }
        } finally {
            foreach ($com in @($item, $folder, $shell)) {
                if ($null -ne $com) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($com) }
            }
        }
    }
}
