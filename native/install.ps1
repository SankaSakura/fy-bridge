param(
    [string]$ExtensionId,
    [ValidateSet('Chrome', 'Edge')][string]$Browser = 'Chrome',
    [switch]$OpenBrowser
)
$ErrorActionPreference = 'Stop'
try {
    $bridgeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $extensionDirectory = Join-Path $bridgeRoot 'extension'
    # Chrome's extension identity algorithm, not a file integrity check.
    # The public identity key is committed; private signing material is absent.
    # Windows PowerShell 5.1 otherwise decodes BOM-less UTF-8 using the ANSI code page.
    $extensionManifest = Get-Content -LiteralPath (Join-Path $extensionDirectory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $identityAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $identityBytes = $identityAlgorithm.ComputeHash([Convert]::FromBase64String($extensionManifest.key)) }
    finally { $identityAlgorithm.Dispose() }
    $fixedId = -join ($identityBytes[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
    if ($ExtensionId -and $ExtensionId -ne $fixedId) { throw '此版本已固定扩展身份，无需填写扩展 ID。请去掉 ExtensionId 参数后重试。' }
    $ExtensionId = $fixedId
    $installDir = Join-Path $bridgeRoot '.local/native-messaging'
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $nodePath) { throw '未找到 Node.js。请从 https://nodejs.org/ 安装 Node.js 22 或更高版本，再重新运行安装程序。' }
    if ([int]([System.Diagnostics.FileVersionInfo]::GetVersionInfo($nodePath).FileMajorPart) -lt 22) { throw 'Node.js 版本过旧。请安装 Node.js 22 或更高版本，再重新运行安装程序。' }
    $compilerPaths = @(
        (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
    )
    $compiler = $compilerPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $compiler) { throw '未找到 Windows .NET Framework 编译器。请安装或修复 .NET Framework 4.8 后重试。' }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $binaryPath = Join-Path $installDir 'fy-bridge-host.exe'
    $newBinaryPath = Join-Path $installDir 'fy-bridge-host.new.exe'
    & $compiler /nologo /target:exe /optimize+ /codepage:65001 "/out:$newBinaryPath" (Join-Path $PSScriptRoot 'Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw '浏览器启动器生成失败，请查看上方错误信息。' }
    try { Move-Item -LiteralPath $newBinaryPath -Destination $binaryPath -Force }
    catch { throw '无法更新浏览器启动器。请先停止反代、退出浏览器，再重新运行安装程序。' }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $origin = "chrome-extension://$ExtensionId/"
    [System.IO.File]::WriteAllText((Join-Path $installDir 'node-path.txt'), $nodePath, $utf8)
    [System.IO.File]::WriteAllText((Join-Path $installDir 'allowed-origin.txt'), $origin, $utf8)
    $manifestPath = Join-Path $installDir 'local.fy.bridge.json'
    $manifest = [ordered]@{
        name = 'local.fy.bridge'
        description = 'fy local bridge launcher'
        path = $binaryPath
        type = 'stdio'
        allowed_origins = @($origin)
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8)
    $vendor = if ($Browser -eq 'Edge') { 'Microsoft/Edge' } else { 'Google/Chrome' }
    $registryPath = ('Software/' + $vendor + '/NativeMessagingHosts/local.fy.bridge').Replace('/', '\')
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
    try { $registryKey.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $registryKey.Dispose() }
    Write-Host "$Browser 本地启动器已安装。"
    Write-Host '接下来请在浏览器中加载 FY 扩展；安装程序不会发送聊天请求。'
    if ($OpenBrowser) {
        try { Set-Clipboard -Value $extensionDirectory }
        catch { Write-Warning '未能自动复制扩展目录，请使用安装引导页中的复制按钮。' }
        $browserExecutable = if ($Browser -eq 'Edge') { 'msedge.exe' } else { 'chrome.exe' }
        $browserLocation = @(
            "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\$browserExecutable",
            "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\$browserExecutable"
        ) | ForEach-Object { Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
        $browserPath = if ($browserLocation) { $browserLocation.'(default)' } else { (Get-Command $browserExecutable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
        if (-not $browserPath) {
            $browserFolder = if ($Browser -eq 'Edge') { 'Microsoft/Edge/Application/msedge.exe' } else { 'Google/Chrome/Application/chrome.exe' }
            $browserPath = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ } | ForEach-Object { Join-Path $_ $browserFolder } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        }
        $extensionPage = if ($Browser -eq 'Edge') { 'edge://extensions/' } else { 'chrome://extensions/' }
        # Chrome filters most internal URLs from command-line launch targets.
        # Open a local guide with copy controls instead of an empty window.
        $guideTemplate = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install-guide.html'), [Text.Encoding]::UTF8)
        $guideHtml = $guideTemplate.Replace('__BROWSER_NAME__', $Browser).Replace('__EXTENSIONS_PAGE__', $extensionPage).Replace('__EXTENSION_DIRECTORY__', [Security.SecurityElement]::Escape($extensionDirectory))
        $guidePath = Join-Path $installDir 'install-guide.html'
        [IO.File]::WriteAllText($guidePath, $guideHtml, $utf8)
        $guideUrl = ([Uri]::new($guidePath, [UriKind]::Absolute)).AbsoluteUri
        if ($browserPath) {
            $browserStart = New-Object System.Diagnostics.ProcessStartInfo
            $browserStart.FileName = ([string]$browserPath).Trim('"')
            $browserStart.UseShellExecute = $false
            $browserStart.Arguments = '"' + $guideUrl + '"'
            try { [System.Diagnostics.Process]::Start($browserStart) | Out-Null }
            catch { Write-Warning '无法自动打开浏览器。请手动打开下方安装引导页。' }
        } else {
            Write-Warning "未找到 $Browser。请用该浏览器手动打开下方安装引导页。"
        }
        Write-Host "安装引导页：$guidePath"
        Write-Host "扩展目录：$extensionDirectory"
        Write-Host "扩展管理页：$extensionPage"
        Write-Host '在浏览器地址栏粘贴管理页地址并按回车，开启开发者模式，选择“加载已解压的扩展程序”。'
        Write-Host '选择上方扩展目录。若已经加载过此扩展，点击“重新加载”即可。'
    }
} catch {
    Write-Host ('安装未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
