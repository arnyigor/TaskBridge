$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsReader.cs')
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $result = [TaskBridgeWindowsReader]::Execute($request.root, $request.path, $request.operation, $request.maxBytes, $request.offset, $request.limit)
    $result | ConvertTo-Json -Depth 8 -Compress
} catch {
    $code = 'FILE_FORBIDDEN'
    if ($_.Exception.ToString().Contains('BODY_TOO_LARGE')) { $code = 'BODY_TOO_LARGE' }
    @{ error = $code } | ConvertTo-Json -Compress
    exit 1
}
