# grokbot-x one-click installer for Windows (current user).
# Official usage (PowerShell):
#   irm https://github.com/younglark/grokbot-x/releases/latest/download/install.ps1 | iex
#
# Does not require Administrator, does not install the official Grok Bot
# client, and does not enable login autostart.
$ErrorActionPreference = 'Stop'

$Repo = 'younglark/grokbot-x'
$DefaultBase = "https://github.com/$Repo/releases/latest/download"
if ($env:GROKBOT_X_RELEASE_BASE) { $Base = $env:GROKBOT_X_RELEASE_BASE.TrimEnd('/') } else { $Base = $DefaultBase }

function Write-Info([string]$Message) {
    Write-Host "grokbot-x：$Message"
}

function Throw-Install([string]$Message) {
    throw "grokbot-x 安装失败：$Message"
}

# We only ship an x64 NSIS installer. ARM64 Windows can run it via emulation.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'x86') {
    Throw-Install "目前只提供 Windows x64 安装包（当前架构：$arch）"
}

function Get-FileSha512Base64([string]$Path) {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hash = $sha.ComputeHash($stream)
        return [Convert]::ToBase64String($hash)
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

# Parse electron-builder latest.yml; pick the first files[].url that contains $Want.
# Returns a hashtable: Version, FileName, Sha512
function Get-YmlScalar([string]$Value) {
    $v = $Value.Trim()
    if ($v.StartsWith([char]34) -and $v.EndsWith([char]34) -and $v.Length -ge 2) {
        return $v.Substring(1, $v.Length - 2)
    }
    if ($v.StartsWith([char]39) -and $v.EndsWith([char]39) -and $v.Length -ge 2) {
        return $v.Substring(1, $v.Length - 2)
    }
    return $v
}

function Parse-LatestYml([string]$Path, [string]$Want) {
    $version = $null
    $url = $null
    $sha = $null
    $pendingUrl = $null
    $pendingSha = $null
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if ($line -match '^version:\s*(.+)$') {
            $version = Get-YmlScalar $Matches[1]
            continue
        }
        if ($line -match '^(?:-\s+)?url:\s*(.+)$') {
            $pendingUrl = Get-YmlScalar $Matches[1]
            $pendingSha = $null
            continue
        }
        if ($line -match '^sha512:\s*(.+)$' -and $pendingUrl -and -not $pendingSha) {
            $pendingSha = Get-YmlScalar $Matches[1]
            if ($pendingUrl.Contains($Want) -and -not $url) {
                $url = $pendingUrl
                $sha = $pendingSha
            }
        }
    }
    if (-not $version -or -not $url -or -not $sha) {
        Throw-Install "在 latest.yml 里找不到匹配 $Want 的资源。Release 是否已发布？"
    }
    return @{ Version = $version; FileName = $url; Sha512 = $sha }
}

function Download-File([string]$Url, [string]$Dest) {
    Write-Info "正在下载 $Url"
    # Use WebClient so this works on Windows PowerShell 5 and PowerShell 7.
    $client = New-Object System.Net.WebClient
    $client.Headers['User-Agent'] = 'grokbot-x-installer'
    try {
        $client.DownloadFile($Url, $Dest)
    } catch {
        Throw-Install "下载失败：$Url`n$($_.Exception.Message)"
    } finally {
        $client.Dispose()
    }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("grokbot-x-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $yml = Join-Path $tmp 'latest.yml'
    Download-File "$Base/latest.yml" $yml
    $meta = Parse-LatestYml $yml 'win-x64-setup.exe'
    Write-Info "最新版本：$($meta.Version)"
    $setup = Join-Path $tmp $meta.FileName
    Download-File "$Base/$($meta.FileName)" $setup
    Write-Info "正在校验 sha512…"
    $actual = Get-FileSha512Base64 $setup
    if ($actual -ne $meta.Sha512) {
        Throw-Install "校验和不匹配，已中止安装。`n  期望 sha512: $($meta.Sha512)`n  实际 sha512: $actual"
    }
    Write-Info "正在安装（当前用户，静默）…"
    $proc = Start-Process -FilePath $setup -ArgumentList @('/S', '/currentuser') -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Throw-Install "安装器退出码：$($proc.ExitCode)"
    }
    Write-Info "安装完成（版本 $($meta.Version)）。"
    Write-Info "本安装包未签名，Windows SmartScreen 可能提示未知发布者。请从本仓库的 GitHub Release 下载。"
    Write-Info "未开启登录自启，也未安装官方 Grok Bot。"
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
