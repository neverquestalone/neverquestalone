# Azure Artifact Signing's PowerShell module for the Windows release build, pinned (systems critic
# SY-31). electron-builder's own Azure signer runs `Install-Module TrustedSigning -MinimumVersion
# 0.5.0` from the PowerShell Gallery, whatever version is newest, inside the job that holds the
# signing sign-in. Instead, release.yml runs this before the Azure sign-in:
#
#   - TrustedSigning 0.5.8 from the PowerShell Gallery, and the three NuGet packages it runs, each
#     at the exact version the module names (signtool from the Windows SDK build tools, the Trusted
#     Signing dlib that signtool loads with the sign-in, and the sign CLI), downloaded and their
#     SHA-256 checked against the values below before anything in them is imported or run;
#   - each package put where the module looks for it, so its Get-EveryDependency finds them all
#     and downloads nothing (checked below, in the module's own words);
#   - signtool.exe and the dlib checked Valid and signed by Microsoft.
#
# scripts/sign-azure.cjs (electron-builder's sign hook, set by scripts/dist.mjs) then signs every
# file with Invoke-TrustedSigning from this copy, so nothing is installed while the job holds the
# sign-in. A dry run of release.yml stages it too: it needs no secret.
#
#   pwsh -NoProfile -File tools/stage-trusted-signing.ps1 [-Destination <folder>]
#
# Prints NQA_TRUSTED_SIGNING_MODULE=<the module's .psd1>, and writes it to $env:GITHUB_ENV when
# there is one. Any other checksum is refused and the download deleted.
#
# Moving to another version: take its .nupkg from the gallery (api/v2/package/<id>/<version>) or
# nuget.org, check its SHA-512 against the one the gallery publishes for that version (the
# Packages(Id,Version) feed entry, or nuget.org's catalog), and put its SHA-256 here. The module's
# NugetInstall.psm1 names its packages' versions; this script refuses a module that names others.
#Requires -Version 7.0
param(
  [string] $Destination = (Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }) 'trusted-signing')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Module = @{ Id = 'TrustedSigning'; Version = '0.5.8'; Sha256 = 'a6efb194854ccf028249db9549c3fddc1160a2d6f6e83c4b608bc89050c43bbd' }
$Packages = @(
  @{ Id = 'Microsoft.Windows.SDK.BuildTools'; Version = '10.0.26100.4188'; Sha256 = '180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022' }
  @{ Id = 'Microsoft.Trusted.Signing.Client'; Version = '1.0.95'; Sha256 = '3bfcf1e0a3cb42af1692f0a8ed45c15de070c2de86f28a59b2795d904d8a920f' }
  @{ Id = 'sign'; Version = '0.9.1-beta.24469.1'; Sha256 = '08547275544d32ecc1fadac466b93da6b71075a98e9a72c21124f8b8c2340019' }
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

# Downloads one pinned package, refuses it unless its SHA-256 is the pinned one, and unpacks it into $To.
function Get-Pinned([hashtable] $Pin, [string] $Url, [string] $To) {
  $file = Join-Path $Destination "$($Pin.Id).$($Pin.Version).nupkg"
  Invoke-WebRequest -Uri $Url -OutFile $file -MaximumRetryCount 4 -RetryIntervalSec 5
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($got -ne $Pin.Sha256) {
    Remove-Item -LiteralPath $file -Force
    throw "refusing $($Pin.Id) $($Pin.Version): its SHA-256 is $got, not the pinned $($Pin.Sha256)"
  }
  if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
  [IO.Compression.ZipFile]::ExtractToDirectory($file, $To)
  Remove-Item -LiteralPath $file -Force
  Write-Output "$($Pin.Id) $($Pin.Version): SHA-256 $got, as pinned"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$moduleDir = Join-Path $Destination "TrustedSigning\$($Module.Version)"
Get-Pinned $Module "https://www.powershellgallery.com/api/v2/package/$($Module.Id)/$($Module.Version)" $moduleDir
$psd1 = Join-Path $moduleDir 'TrustedSigning.psd1'
$m = Import-Module -Name $psd1 -PassThru -Force
if ("$($m.Version)" -ne $Module.Version) { throw "the staged module says it is $($m.Version), not $($Module.Version)" }

# Where the module looks for each package, from its own functions.
$wants = & $m { @(Get-BuildToolsPackageInfo; Get-TrustedSigningPackageInfo; Get-SignCliPackageInfo) }
foreach ($pin in $Packages) {
  $want = @($wants | Where-Object { $_.PackageName -eq $pin.Id })
  if ($want.Count -ne 1 -or $want[0].PackageVersion -ne $pin.Version) { throw "TrustedSigning $($Module.Version) doesn't run $($pin.Id) $($pin.Version)" }
  Get-Pinned $pin "https://www.nuget.org/api/v2/package/$($pin.Id)/$($pin.Version)" $want[0].PackageInstallPath
  if (-not (Test-Path -LiteralPath $want[0].ContentPath)) { throw "$($pin.Id) $($pin.Version) has no $($want[0].ContentPath)" }
}
if ($wants.Count -ne $Packages.Count) { throw "TrustedSigning $($Module.Version) runs $($wants.Count) packages, not the $($Packages.Count) pinned here" }

# The module's own check, as Invoke-TrustedSigning makes it before it signs: everything is there.
$said = (& $m { Get-EveryDependency 6>&1 } | Out-String)
if ($said -notmatch 'All required dependencies are installed') { throw "TrustedSigning doesn't find the staged packages: $said" }

# The two programs that hold the sign-in: Microsoft's, Valid.
$tools = @(
  (Join-Path ($wants | Where-Object { $_.PackageName -eq 'Microsoft.Windows.SDK.BuildTools' }).ContentPath 'signtool.exe')
  (Join-Path ($wants | Where-Object { $_.PackageName -eq 'Microsoft.Trusted.Signing.Client' }).ContentPath 'Azure.CodeSigning.Dlib.dll')
)
foreach ($f in $tools) {
  $s = Get-AuthenticodeSignature -LiteralPath $f
  $who = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '-' }
  if ($s.Status -ne 'Valid' -or $who -notmatch '(^|, )O=Microsoft Corporation(,|$)') { throw "$(Split-Path -Leaf $f): $($s.Status), signed by $who" }
  Write-Output "$(Split-Path -Leaf $f): Valid, $who"
}

Write-Output "NQA_TRUSTED_SIGNING_MODULE=$psd1"
if ($env:GITHUB_ENV) { "NQA_TRUSTED_SIGNING_MODULE=$psd1" | Out-File -Append -Encoding utf8 -FilePath $env:GITHUB_ENV }
