# Patterm's updater runs this detached before it quits. It waits for the app to
# exit, runs the installer next to it, and opens Patterm again, updated or not.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$WaitPid,
    [Parameter(Mandatory)][string]$Log,
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Sha256
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $Log) -Force | Out-Null
function Write-Log([string]$Message) {
    Add-Content -LiteralPath $Log -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message)
}

$status = 1
try {
    Write-Log "waiting for Patterm (pid $WaitPid) to quit"
    $process = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
    # A quit that never happens cancels the update rather than surprising a later one.
    if ($process -and -not $process.WaitForExit(600000)) {
        Write-Log 'Patterm did not quit; the update was cancelled'
        exit 1
    }
    # The installer refuses while any of Patterm's Electron processes remain.
    $prefix = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    for ($waited = 0; $waited -lt 60; $waited++) {
        $running = @(Get-CimInstance Win32_Process -Filter "Name = 'Patterm.exe' OR Name = 'electron.exe'" | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($running.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    Write-Log "installing Patterm $Version"
    # -NoPath keeps the PATH choice made at the first install.
    & (Join-Path $PSScriptRoot 'install.ps1') -InstallRoot $InstallRoot -Version $Version -Sha256 $Sha256 -NoPath *>> $Log
    $status = 0
    Write-Log 'installer finished'
} catch {
    Write-Log "installer failed: $($_.Exception.Message)"
} finally {
    $launcher = Join-Path $InstallRoot 'bin\patterm.cmd'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WindowStyle Hidden }
}
exit $status
