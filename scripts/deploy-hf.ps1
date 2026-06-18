#Requires -Version 5.1
<#
.SYNOPSIS
    HuggingFace Spaces 部署脚本（PowerShell 版）

.DESCRIPTION
    从环境变量或 .env.hf 文件读取配置，推送项目到 HF Space。
    配置优先级：环境变量 > .env.hf 文件 > 默认值

.PARAMETER EnvFile
    .env.hf 文件路径，默认为项目根目录 .env.hf

.PARAMETER WhatIf
    预览模式，不执行实际操作

.EXAMPLE
    # 方式一：使用 .env.hf 文件（推荐）
    Copy-Item .env.hf.example .env.hf
    # 编辑 .env.hf 填入实际值
    .\scripts\deploy-hf.ps1

    # 方式二：指定其他配置文件
    .\scripts\deploy-hf.ps1 -EnvFile ".env.hf.local"

    # 方式三：环境变量覆盖
    $env:HF_TOKEN="hf_override"
    .\scripts\deploy-hf.ps1

    # 方式四：预览模式
    .\scripts\deploy-hf.ps1 -WhatIf
#>
param(
    [string]$EnvFile = ".env.hf",
    [switch]$WhatIf
)

# ========== 函数定义 ==========

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("INFO","OK","WARN","ERROR")]
        [string]$Level = "INFO"
    )
    $colors = @{
        "INFO"  = "Cyan"
        "OK"    = "Green"
        "WARN"  = "Yellow"
        "ERROR" = "Red"
    }
    Write-Host "[$Level] $Message" -ForegroundColor $colors[$Level]
}

function Get-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return @{}
    }

    $envVars = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $parts = $line -split '=', 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim()
                $envVars[$key] = $value
            }
        }
    }
    return $envVars
}

function Test-RequiredVars {
    param(
        [string]$Token,
        [string]$Username,
        [string]$SpaceName,
        [string]$GeminiApiKey
    )

    if (-not $Token -or $Token -eq "hf_xxxxxxxxxxxxxxxxx") {
        throw "请设置 HF_TOKEN（检查 .env.hf 或环境变量）"
    }
    if (-not $Username -or $Username -eq "your-hf-username") {
        throw "请设置 HF_USERNAME（检查 .env.hf 或环境变量）"
    }
    if (-not $SpaceName) {
        throw "请设置 HF_SPACE_NAME（检查 .env.hf 或环境变量）"
    }
    if (-not $GeminiApiKey -or $GeminiApiKey -eq "your-gemini-api-key") {
        throw "请设置 GEMINI_API_KEY（构建时需要用于 pnpm build）"
    }
}

# ========== 主逻辑 ==========

try {
    Write-Log "HuggingFace Spaces 部署脚本启动"

    # 1. 确定项目目录
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $projectDir = Split-Path -Parent $scriptDir

    # 2. 加载 .env.hf 文件
    $envFilePath = Join-Path $projectDir $EnvFile
    if (Test-Path $envFilePath) {
        Write-Log "加载配置文件: $envFilePath"
        $envVars = Get-EnvFile -Path $envFilePath
    } else {
        Write-Log ".env.hf 文件不存在，将仅使用环境变量" "WARN"
        Write-Log "提示: Copy-Item .env.hf.example .env.hf 然后编辑填入实际值" "WARN"
        $envVars = @{}
    }

    # 3. 读取变量（优先级：环境变量 > .env.hf 文件）
    $hfToken = if ($env:HF_TOKEN) { $env:HF_TOKEN } else {
        if ($envVars.ContainsKey("HF_TOKEN")) { $envVars["HF_TOKEN"] } else { "" }
    }
    $hfUsername = if ($env:HF_USERNAME) { $env:HF_USERNAME } else {
        if ($envVars.ContainsKey("HF_USERNAME")) { $envVars["HF_USERNAME"] } else { "" }
    }
    $hfSpaceName = if ($env:HF_SPACE_NAME) { $env:HF_SPACE_NAME } else {
        if ($envVars.ContainsKey("HF_SPACE_NAME")) { $envVars["HF_SPACE_NAME"] } else { "" }
    }
    $geminiApiKey = if ($env:GEMINI_API_KEY) { $env:GEMINI_API_KEY } else {
        if ($envVars.ContainsKey("GEMINI_API_KEY")) { $envVars["GEMINI_API_KEY"] } else { "" }
    }

    # 4. 校验变量
    Test-RequiredVars -Token $hfToken -Username $hfUsername -SpaceName $hfSpaceName -GeminiApiKey $geminiApiKey

    Write-Log "项目目录: $projectDir"
    Write-Log "用户名: $hfUsername"
    Write-Log "Space: $hfSpaceName"
    Write-Log "GEMINI_API_KEY: 已配置"

    # 5. 创建临时目录
    $tmpDir = Join-Path $env:TEMP "deploy-hf-$([System.IO.Path]::GetRandomFileName().Substring(0,8))"
    if (-not $WhatIf) {
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    }
    Write-Log "临时目录: $tmpDir"

    # 6. 复制文件到临时目录
    $filesToCopy = @(
        "src",
        "assets",
        "scripts/entrypoint.sh",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json"
    )

    # 复制 Dockerfile.hf → 临时目录/Dockerfile（不覆盖项目目录的 Dockerfile）
    if (Test-Path "$projectDir\Dockerfile.hf") {
        if (-not $WhatIf) {
            Copy-Item -Path "$projectDir\Dockerfile.hf" -Destination "$tmpDir\Dockerfile" -Force
        }
        Write-Log "  ✓ Dockerfile (from Dockerfile.hf)"
    } else {
        Write-Log "  ✗ Dockerfile.hf (不存在，跳过)" "WARN"
    }

    # 复制 README.hf.md → 临时目录/README.md（HF Space 配置）
    if (Test-Path "$projectDir\README.hf.md") {
        if (-not $WhatIf) {
            Copy-Item -Path "$projectDir\README.hf.md" -Destination "$tmpDir\README.md" -Force
        }
        Write-Log "  ✓ README.md (from README.hf.md)"
    } else {
        Write-Log "  ✗ README.hf.md (不存在，跳过)" "WARN"
    }

    # 处理 .dockerignore
    $dockerignoreGenerated = $false
    if (Test-Path "$projectDir\.dockerignore") {
        $filesToCopy += ".dockerignore"
    } else {
        $dockerignoreContent = @"
node_modules/
dist/
.git/
.env
.env.*
*.log
*.md
.vscode/
.idea/
coverage/
test/
"@
        if (-not $WhatIf) {
            Set-Content -Path "$tmpDir\.dockerignore" -Value $dockerignoreContent
        }
        $filesToCopy += ".dockerignore"
        $dockerignoreGenerated = $true
    }

    Write-Log "复制项目文件到临时目录..."
    foreach ($item in $filesToCopy) {
        if ($item -eq ".dockerignore" -and $dockerignoreGenerated) {
            Write-Log "  ✓ $item (生成)"
            continue
        }

        $src = Join-Path $projectDir $item
        if (Test-Path $src) {
            if (-not $WhatIf) {
                $destDir = Join-Path $tmpDir (Split-Path -Parent $item)
                if (-not (Test-Path $destDir)) {
                    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                }
                Copy-Item -Path $src -Destination $destDir -Recurse -Force
            }
            Write-Log "  ✓ $item"
        } else {
            Write-Log "  ✗ $item (不存在，跳过)" "WARN"
        }
    }

    # 验证临时目录
    if (-not $WhatIf) {
        $items = Get-ChildItem -Path $tmpDir -Force
        if ($items.Count -eq 0) {
            throw "临时目录为空，没有任何文件被复制"
        }
        Write-Log "共复制 $($items.Count) 个文件/目录到临时目录"
    }

    # 8. 初始化 Git 并推送
    $spaceRemote = "https://${hfUsername}:${hfToken}@huggingface.co/spaces/${hfUsername}/${hfSpaceName}"

    if (-not $WhatIf) {
        Push-Location $tmpDir

        git init 2>&1 | Out-Null
        git config user.name "$hfUsername"
        git config user.email "${hfUsername}@users.huggingface.co"
        git remote add origin "$spaceRemote"

        git checkout -b main
        git add -A
        $commitMessage = "deploy: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
        $commitResult = git commit -m $commitMessage --quiet 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "git commit 失败" "ERROR"
            Write-Log "当前目录: $(Get-Location)" "ERROR"
            Write-Log "目录内容:" "ERROR"
            Get-ChildItem -Path $tmpDir -Force | Format-Table Name, Length, LastWriteTime
            Write-Log "git status:" "ERROR"
            git status
            throw "无法创建提交，请检查文件是否正确复制"
        }

        Write-Log "推送至: https://huggingface.co/spaces/$hfUsername/$hfSpaceName"
        Write-Log "正在推送..."

        $pushResult = git push -u origin main --force 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Log "✅ 代码推送成功！" "OK"
            Write-Log "Space 地址: https://huggingface.co/spaces/$hfUsername/$hfSpaceName" "OK"
        } else {
            throw "推送失败，请检查 HF_TOKEN / HF_USERNAME / HF_SPACE_NAME 是否正确"
        }

        # 设置 GEMINI_API_KEY Secret
        Write-Log "设置 GEMINI_API_KEY Secret..."
        $secretBody = @{ key = "GEMINI_API_KEY"; value = $geminiApiKey } | ConvertTo-Json
        try {
            $response = Invoke-RestMethod -Uri "https://huggingface.co/api/spaces/$hfUsername/$hfSpaceName/secrets" `
                -Method POST `
                -Headers @{ Authorization = "Bearer $hfToken" } `
                -Body $secretBody `
                -ContentType "application/json" `
                -ErrorAction Stop
            Write-Log "  ✓ GEMINI_API_KEY Secret 已设置" "OK"
        } catch {
            Write-Log "  ⚠ GEMINI_API_KEY Secret 设置失败: $($_.Exception.Message)" "WARN"
            Write-Log "  请手动在 HF Space Settings → Repository secrets 中添加" "WARN"
        }

        Pop-Location
    } else {
        Write-Log "[WhatIf] 将推送到: https://huggingface.co/spaces/$hfUsername/$hfSpaceName"
        Write-Log "[WhatIf] 将设置 GEMINI_API_KEY Secret"
    }

} catch {
    Write-Log $_.Exception.Message "ERROR"
    exit 1
} finally {
    if ((Test-Path $tmpDir) -and -not $WhatIf) {
        Write-Log "清理临时目录..."
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
