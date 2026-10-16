param([ValidateSet('Chrome', 'Edge')][string]$Browser = 'Chrome')
$ErrorActionPreference = 'Stop'
$bridgeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $bridgeRoot '.local/native-messaging/local.fy.bridge.json'
$vendor = if ($Browser -eq 'Edge') { 'Microsoft/Edge' } else { 'Google/Chrome' }
$registryPath = ('Software/' + $vendor + '/NativeMessagingHosts/local.fy.bridge').Replace('/', '\')
$registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
if ($registryKey) {
    try { $registered = [string]$registryKey.GetValue('') }
    finally { $registryKey.Dispose() }
    if (-not [String]::Equals($registered, $manifestPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw '当前登记指向另一个安装目录。请从对应目录卸载；本次没有更改任何设置。'
    }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($registryPath)
}
Write-Host '浏览器启动器登记已移除。请在浏览器扩展管理页中移除 FY 扩展。已保存的密钥和运行中的服务未更改。'
