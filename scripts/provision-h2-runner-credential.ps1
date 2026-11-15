$ErrorActionPreference = "Stop"

if (-not $env:LOCALAPPDATA) {
  throw "No se encontró el perfil local de Windows."
}

$directory = Join-Path $env:LOCALAPPDATA "SIGECOM\h2-runner-7-2c"
$credentialPath = Join-Path $directory "credential.dpapi"
if (Test-Path -LiteralPath $directory) {
  throw "El directorio temporal de credenciales ya existe; no se sobrescribió."
}

$securePassword = Read-Host -AsSecureString -Prompt "Local sigecom_h2_runner credential (hidden input)"
if ($securePassword.Length -lt 1) {
  throw "The credential cannot be empty."
}

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directorySecurity = [System.Security.AccessControl.DirectorySecurity]::new()
$directorySecurity.SetAccessRuleProtection($true, $false)
$directorySecurity.SetOwner($sid)
$directoryRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$directorySecurity.AddAccessRule($directoryRule)
[System.IO.Directory]::CreateDirectory($directory) | Out-Null
Set-Acl -LiteralPath $directory -AclObject $directorySecurity

$encryptedPassword = ConvertFrom-SecureString -SecureString $securePassword
$encoding = [System.Text.UTF8Encoding]::new($false)
$fileStream = [System.IO.File]::Open(
  $credentialPath,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::None
)
try {
  $bytes = $encoding.GetBytes($encryptedPassword)
  $fileStream.Write($bytes, 0, $bytes.Length)
  [System.Array]::Clear($bytes, 0, $bytes.Length)
}
finally {
  $fileStream.Dispose()
}

$fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
$fileSecurity.SetAccessRuleProtection($true, $false)
$fileSecurity.SetOwner($sid)
$fileRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$fileSecurity.AddAccessRule($fileRule)
Set-Acl -LiteralPath $credentialPath -AclObject $fileSecurity
$securePassword.Dispose()
Remove-Variable encryptedPassword, securePassword -ErrorAction SilentlyContinue

Write-Output "Temporary credential protected with DPAPI and current-user-only ACL."
