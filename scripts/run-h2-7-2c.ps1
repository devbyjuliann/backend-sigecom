param(
  [switch]$VerifyOnly,
  [switch]$DashboardReadOnly,
  [switch]$Playwright,
  [switch]$CleanupH2E2E,
  [string]$H2E2ERunId
)

$ErrorActionPreference = "Stop"
$exitCode = 1
$passwordPointer = [IntPtr]::Zero
$password = $null
$credentialPath = Join-Path $env:LOCALAPPDATA "SIGECOM\h2-runner-7-2c\credential.dpapi"
$backendRoot = Split-Path -Parent $PSScriptRoot
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User

function Assert-PrivateAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Credential file cannot be a symbolic link or reparse point."
  }
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if (-not $acl.AreAccessRulesProtected -or $ownerSid -ne $sid.Value) {
    throw "Credential protection does not match the current Windows user."
  }
  $rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  if (
    $rules.Count -ne 1 -or
    $rules[0].IdentityReference.Value -ne $sid.Value -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl
  ) {
    throw "Credential ACL must grant access exclusively to the current user."
  }
}

try {
  if (@($VerifyOnly, $DashboardReadOnly, $Playwright, $CleanupH2E2E).Where({ $_ }).Count -gt 1) {
    throw "Choose only one read-only mode."
  }
  if ($CleanupH2E2E -and $H2E2ERunId -notmatch '^[a-f0-9]{12}$') {
    throw "Cleanup requires an explicit 12-character H2 E2E RUN_ID."
  }
  $directory = Split-Path -Parent $credentialPath
  if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw "The local temporary credential file is missing."
  }
  Assert-PrivateAcl -Path $directory
  Assert-PrivateAcl -Path $credentialPath

  $encryptedPassword = [System.IO.File]::ReadAllText($credentialPath, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($encryptedPassword)) {
    throw "The local credential file is empty."
  }
  $securePassword = ConvertTo-SecureString -String $encryptedPassword
  $passwordPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $password = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  if ([string]::IsNullOrEmpty($password)) {
    throw "Could not decrypt the credential for the current Windows user."
  }

  $env:SIGECOM_H2_DATABASE = "sigecom_h2_concurrency"
  $env:SIGECOM_H2_USER = "sigecom_h2_runner"
  $env:SIGECOM_H2_PASSWORD = $password
  Push-Location $backendRoot
  try {
    if ($CleanupH2E2E) {
      $env:SIGECOM_H2_E2E_TARGET = "sigecom_h2_concurrency"
      $env:SIGECOM_H2_DATABASE = "sigecom_h2_concurrency"
      $env:SIGECOM_H2_USER = "sigecom_h2_runner"
      $env:SIGECOM_H2_E2E_SQL_HOST = "127.0.0.1"
      $env:SIGECOM_H2_E2E_SQL_PORT = "3306"
      $env:SIGECOM_H2_E2E_RUN_ID = $H2E2ERunId
      $env:SIGECOM_H2_E2E_API_PORT = "3202"
      $env:SIGECOM_H2_E2E_FRONTEND_PORT = "5175"
      $env:SIGECOM_H2_E2E_JWT_SECRET = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
      $env:SIGECOM_H2_E2E_FIXTURE_PASSWORD = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
      $env:SIGECOM_H2_E2E_RESULTS_DIR = Join-Path $env:LOCALAPPDATA "SIGECOM\h2-e2e\$H2E2ERunId"
      Write-Output "Cleaning only the explicitly named H2 E2E RUN_ID fixtures..."
      & node scripts/h2-e2e/fixtures-cli.js cleanup
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        Write-Output "Verifying the H2 schema is free of E2E residues..."
        & node scripts/verify-h2c7-residues.js
        $exitCode = $LASTEXITCODE
      }
    }
    else {
    Write-Output "Running the H2C7 read-only residue verification first..."
    & node scripts/verify-h2c7-residues.js
    $verificationExitCode = $LASTEXITCODE
    if ($verificationExitCode -ne 0) {
      $exitCode = $verificationExitCode
    }
    elseif ($VerifyOnly) {
      Write-Output "Read-only residue verification completed; no integration writes were run."
      $exitCode = 0
    }
    elseif ($DashboardReadOnly) {
      Write-Output "No residues found; running only the authorized Dashboard SELECT smoke test..."
      & node scripts/smoke-dashboard-readonly.js
      $smokeExitCode = $LASTEXITCODE
      if ($smokeExitCode -ne 0) {
        $exitCode = $smokeExitCode
      }
      else {
        Write-Output "Running the read-only residue verification again..."
        & node scripts/verify-h2c7-residues.js
        $exitCode = $LASTEXITCODE
      }
    }
    elseif ($Playwright) {
      $frontendRoot = Join-Path (Split-Path -Parent $backendRoot) "frontend-sigecom"
      $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      $runBytes = New-Object byte[] 6
      $jwtBytes = New-Object byte[] 48
      $fixturePasswordBytes = New-Object byte[] 32
      $randomGenerator.GetBytes($runBytes)
      $randomGenerator.GetBytes($jwtBytes)
      $randomGenerator.GetBytes($fixturePasswordBytes)
      $runId = [BitConverter]::ToString($runBytes).Replace('-', '').ToLowerInvariant()
      $randomGenerator.Dispose()
      $jwtSecret = [Convert]::ToBase64String($jwtBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
      $fixturePassword = [Convert]::ToBase64String($fixturePasswordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
      $resultsDirectory = Join-Path $env:LOCALAPPDATA "SIGECOM\h2-e2e\$runId"
      [System.IO.Directory]::CreateDirectory($resultsDirectory) | Out-Null

      $env:SIGECOM_H2_E2E_TARGET = "sigecom_h2_concurrency"
      $env:SIGECOM_H2_DATABASE = "sigecom_h2_concurrency"
      $env:SIGECOM_H2_USER = "sigecom_h2_runner"
      $env:SIGECOM_H2_E2E_SQL_HOST = "127.0.0.1"
      $env:SIGECOM_H2_E2E_SQL_PORT = "3306"
      $env:SIGECOM_H2_E2E_RUN_ID = $runId
      $env:SIGECOM_H2_E2E_API_PORT = "3202"
      $env:SIGECOM_H2_E2E_FRONTEND_PORT = "5175"
      $env:SIGECOM_H2_E2E_JWT_SECRET = $jwtSecret
      $env:SIGECOM_H2_E2E_FIXTURE_PASSWORD = $fixturePassword
      $env:SIGECOM_H2_E2E_RESULTS_DIR = $resultsDirectory
      $env:SIGECOM_API_TARGET = "http://127.0.0.1:3202"
      $env:SIGECOM_E2E_FRONTEND_PORT = "5175"

      Write-Output "Running the strict H2 E2E read-only preflight before fixture writes..."
      & node scripts/h2-e2e/preflight.js
      if ($LASTEXITCODE -ne 0) { throw "H2 E2E preflight rejected the target." }

      $fixtureCreated = $false
      $playwrightExitCode = 1
      try {
        $fixtureOutput = & node scripts/h2-e2e/fixtures-cli.js setup
        if ($LASTEXITCODE -ne 0) { throw "H2 E2E fixture setup failed." }
        $env:SIGECOM_H2_E2E_FIXTURES_JSON = ($fixtureOutput | Select-Object -Last 1)
        $fixtureCreated = $true
        Push-Location $frontendRoot
        try {
          & node ./node_modules/@playwright/test/cli.js test --config=playwright.h2-e2e.config.js
          $playwrightExitCode = $LASTEXITCODE
        }
        finally { Pop-Location }
      }
      finally {
        Remove-Item Env:\SIGECOM_H2_E2E_FIXTURES_JSON -ErrorAction SilentlyContinue
        Write-Output "Cleaning only the current H2 E2E RUN_ID fixtures..."
        & node scripts/h2-e2e/fixtures-cli.js cleanup
        $cleanupExitCode = $LASTEXITCODE
        if ($cleanupExitCode -ne 0) {
          $exitCode = $cleanupExitCode
        }
        elseif ($fixtureCreated) {
          $exitCode = $playwrightExitCode
        }
      }
    }
    else {
      Write-Output "No residues found; running only the authorized 7.2C integration..."
      & node --test tests/integration/historical-warehouse-scope-7-2c.test.js
      $exitCode = $LASTEXITCODE
    }
    }
  }
  finally {
    Pop-Location
  }
}
catch {
  Write-Error "H2C7 runner stopped before completing verification and tests. Credential was not printed."
  $exitCode = 1
}
finally {
  Remove-Item Env:\SIGECOM_H2_DATABASE -ErrorAction SilentlyContinue
  Remove-Item Env:\SIGECOM_H2_USER -ErrorAction SilentlyContinue
  Remove-Item Env:\SIGECOM_H2_PASSWORD -ErrorAction SilentlyContinue
  @(
    "SIGECOM_H2_E2E_TARGET",
    "SIGECOM_H2_E2E_SQL_HOST",
    "SIGECOM_H2_E2E_SQL_PORT",
    "SIGECOM_H2_E2E_RUN_ID",
    "SIGECOM_H2_E2E_API_PORT",
    "SIGECOM_H2_E2E_FRONTEND_PORT",
    "SIGECOM_H2_E2E_JWT_SECRET",
    "SIGECOM_H2_E2E_FIXTURE_PASSWORD",
    "SIGECOM_H2_E2E_RESULTS_DIR",
    "SIGECOM_API_TARGET",
    "SIGECOM_E2E_FRONTEND_PORT"
  ) | ForEach-Object { Remove-Item "Env:\$_" -ErrorAction SilentlyContinue }
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  if ($securePassword) { $securePassword.Dispose() }
  Remove-Variable password, encryptedPassword, securePassword -ErrorAction SilentlyContinue
  Remove-Variable jwtSecret, fixturePassword -ErrorAction SilentlyContinue
  if ($runBytes) { [Array]::Clear($runBytes, 0, $runBytes.Length) }
  if ($jwtBytes) { [Array]::Clear($jwtBytes, 0, $jwtBytes.Length) }
  if ($fixturePasswordBytes) { [Array]::Clear($fixturePasswordBytes, 0, $fixturePasswordBytes.Length) }
}

exit $exitCode
