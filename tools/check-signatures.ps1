# The Windows release's signature gate (release.yml "Check signatures"). test.yml's windows-smoke
# job runs this same script on every push, against a build signed with a throwaway certificate
# that only its runner trusts, so the gate a release must pass is the one every push already
# passed (systems critic SY-20).
#
# Every .exe, .node and .dll under -Path must carry a Valid Authenticode signature:
#   - the keychain binding (.node): Smart App Control blocks an unsigned one, and then no key
#     can be saved (systems plan SY-01);
#   - Electron's own .dll files (win.signExts; SY-01, round 2);
#   - the capture helper (resources\capture\nqa-capture.exe): an unsigned one is blocked,
#     and the app never hears the game (SY-20);
#   - the app, elevate.exe, the installer and its uninstaller.
# The package must hold the helper, the keychain binding and Electron's .dll files, so a build
# that dropped one can't pass by having less to check. One line per file (status, signer, path);
# the step fails on anything missing or not Valid.
#
#   pwsh -NoProfile -File tools/check-signatures.ps1 -Path app/desktop/dist
param(
  [Parameter(Mandatory = $true)][string] $Path
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')
$files = @(Get-ChildItem -Path $root -Recurse -File -Include *.exe, *.node, *.dll)
$rows = foreach ($f in $files) {
  $s = Get-AuthenticodeSignature -LiteralPath $f.FullName
  [pscustomobject]@{
    Status = [string]$s.Status
    Signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '-' }
    File   = $f.FullName.Substring($root.Length + 1)
  }
}
$rows = @($rows | Sort-Object File)
$rows | Format-Table -AutoSize -Wrap | Out-String -Width 250 | Write-Output

$missing = @()
if (-not ($rows | Where-Object { $_.File -like '*resources\capture\nqa-capture.exe' })) { $missing += 'the capture helper (resources\capture\nqa-capture.exe)' }
if (-not ($rows | Where-Object { $_.File -like '*resources\app.asar.unpacked\*keyring*.node' })) { $missing += 'the keychain binding (a keyring .node in resources\app.asar.unpacked)' }
if (-not ($rows | Where-Object { $_.File -like '*.dll' })) { $missing += "Electron's .dll files" }
$bad = @($rows | Where-Object { $_.Status -ne 'Valid' })

$exe = @($rows | Where-Object { $_.File -like '*.exe' }).Count
$node = @($rows | Where-Object { $_.File -like '*.node' }).Count
$dll = @($rows | Where-Object { $_.File -like '*.dll' }).Count
$line = "$($rows.Count) files ($exe .exe, $node .node, $dll .dll): $($rows.Count - $bad.Count) Valid, $($bad.Count) not"
Write-Output "check-signatures: $line"
if ($env:GITHUB_STEP_SUMMARY) {
  $summary = "### Windows signatures`n$line."
  if ($missing.Count) { $summary += " Missing: $($missing -join '; ')." }
  $summary | Out-File -Append -Encoding utf8 -FilePath $env:GITHUB_STEP_SUMMARY
}
if ($missing.Count) { throw "missing from the package: $($missing -join '; ')" }
if ($bad.Count) { throw "unsigned or invalid: $(($bad | ForEach-Object { "$($_.File) ($($_.Status))" }) -join ', ')" }
