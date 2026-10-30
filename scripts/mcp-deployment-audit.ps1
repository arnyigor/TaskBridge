# DEP-01: read-only metadata audit. Never enables privileges or elevates.
param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class McpDeploymentSecurity {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
 static extern uint GetNamedSecurityInfoW(string name, int kind, uint flags,
   IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
   IntPtr sd, uint revision, uint flags, out IntPtr text, out uint size);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static string Read(string name) {
   IntPtr sd, text;
   // OWNER | GROUP | DACL | SACL | LABEL. Request labels explicitly; do not
   // interpret an inaccessible SACL as empty. No AdjustTokenPrivileges call.
   uint flags = 0x1f;
   uint error = GetNamedSecurityInfoW(name, 1, flags,
     IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
   if (error != 0) throw new System.ComponentModel.Win32Exception((int)error);
   try {
     uint size;
     if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, flags, out text, out size))
       throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
     try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
   } finally { LocalFree(sd); }
 }
}
'@
function Assert-NoReparse([string]$Path) {
 $current = [System.IO.Path]::GetFullPath($Path)
 while ($current) {
  $item = Get-Item -LiteralPath $current -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
   throw 'Reparse point in deployment path; audit refused'
  }
  $parent = [System.IO.Directory]::GetParent($current)
  $current = if ($parent) { $parent.FullName } else { $null }
 }
}
Assert-NoReparse $InstallRoot
$root = (Resolve-Path -LiteralPath $InstallRoot).Path
$store = Join-Path $root 'data\persistent_memory'
$module = Join-Path $root 'src\mcp_tools\core.py'
Assert-NoReparse $module
Assert-NoReparse $store
$paths = @($root, (Join-Path $root 'src'), (Join-Path $root 'src\mcp_tools'),
           (Join-Path $root 'data'), $store, $module)
# Never recurse through an unexamined directory/junction.
$queue = [System.Collections.Generic.Queue[string]]::new()
$queue.Enqueue($store)
while ($queue.Count -gt 0) {
 $dir = $queue.Dequeue()
 $paths += @(Get-ChildItem -LiteralPath $dir -Force -File -Filter '*.md' | Select-Object -ExpandProperty FullName)
 foreach ($child in @(Get-ChildItem -LiteralPath $dir -Force -Directory)) {
  Assert-NoReparse $child.FullName
  $paths += $child.FullName
  $queue.Enqueue($child.FullName)
 }
}
$result = [ordered]@{ scanned=0; saclReadFailures=0; auditAces=0; integrityLabels=0;
    alternateStreams=0; specialFiles=0; streamReadFailures=0; errorCodes=@{}; go=$false }
foreach ($p in @($paths | Sort-Object -Unique)) {
 $result.scanned++
 try {
  $sddl = [McpDeploymentSecurity]::Read($p)
  $split = $sddl -split 'S:', 2
  if ($split.Length -eq 2) {
   $result.integrityLabels += ([regex]::Matches($split[1], '\(ML;')).Count
   # Prepared persistence does not preserve SACL/labels; any SACL ACE is NO-GO.
   $result.auditAces += ([regex]::Matches($split[1], '\(')).Count
  }
 } catch {
  $result.saclReadFailures++
  $e = $_.Exception.GetBaseException()
  $code = if ($e -is [System.ComponentModel.Win32Exception]) { [string]$e.NativeErrorCode } else { $e.GetType().Name }
  if (!$result.errorCodes.ContainsKey($code)) { $result.errorCodes[$code] = 0 }
  $result.errorCodes[$code]++
 }
 $item = Get-Item -LiteralPath $p -Force
 if (!$item.PSIsContainer) {
  if (([int]$item.Attributes -band (-bnot (0x80 -bor 0x20))) -ne 0) { $result.specialFiles++ }
  try {
   $result.alternateStreams += @(Get-Item -LiteralPath $p -Stream '*' | Where-Object {
     $_.Stream -ne ':$DATA' -and $_.Stream -ne '$DATA'
   }).Count
  } catch { $result.streamReadFailures++ }
 }
}
$result.go = $result.saclReadFailures -eq 0 -and $result.auditAces -eq 0 -and
 $result.integrityLabels -eq 0 -and $result.alternateStreams -eq 0 -and
 $result.specialFiles -eq 0 -and $result.streamReadFailures -eq 0
# No note contents, paths, SIDs or descriptors are emitted.
$result | ConvertTo-Json -Depth 4
if (!$result.go) { exit 2 }
