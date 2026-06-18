@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM HuggingFace Spaces 部署脚本（批处理版）
REM
REM 使用方法：
REM   1. 修改下方 HF_TOKEN、HF_USERNAME、HF_SPACE_NAME 的值
REM   2. 双击运行或在命令行执行 scripts\deploy-hf.bat
REM
REM 注意：此脚本直接修改变量，不从 .env 文件读取
REM       Windows PowerShell 用户建议使用 deploy-hf.ps1
REM ============================================================

REM ========== 请修改以下三个变量 ==========
set "HF_TOKEN=hf_xxxxxxxxxxxxxxxxx"
set "HF_USERNAME=your-hf-username"
set "HF_SPACE_NAME=tarot-backend"
set "GEMINI_API_KEY=your-gemini-api-key"
REM ========================================

echo.
echo ========================================
echo   HuggingFace Spaces 部署脚本
echo ========================================
echo.

REM ========== 校验变量 ==========
if "%HF_TOKEN%"=="hf_xxxxxxxxxxxxxxxxx" (
    echo [ERROR] 请先修改脚本中的 HF_TOKEN 为实际值
    echo         文件位置: scripts\deploy-hf.bat
    echo.
    pause
    exit /b 1
)

if "%HF_USERNAME%"=="your-hf-username" (
    echo [ERROR] 请先修改脚本中的 HF_USERNAME 为实际值
    echo         文件位置: scripts\deploy-hf.bat
    echo.
    pause
    exit /b 1
)

if "%HF_SPACE_NAME%"=="" (
    echo [ERROR] 请先修改脚本中的 HF_SPACE_NAME 为实际值
    echo         文件位置: scripts\deploy-hf.bat
    echo.
    pause
    exit /b 1
)

if "%GEMINI_API_KEY%"=="your-gemini-api-key" (
    echo [ERROR] 请先修改脚本中的 GEMINI_API_KEY 为实际值
    echo         文件位置: scripts\deploy-hf.bat
    echo.
    pause
    exit /b 1
)

echo [INFO] 用户名: %HF_USERNAME%
echo [INFO] Space: %HF_SPACE_NAME%
echo [INFO] GEMINI_API_KEY: 已配置
echo.

REM ========== 路径设置 ==========
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "TMP_DIR=%TEMP%\deploy-hf-%RANDOM%"

echo [INFO] 项目目录: %PROJECT_DIR%
echo [INFO] 临时目录: %TMP_DIR%
echo.

REM ========== 1. 创建临时目录并复制文件 ==========
mkdir "%TMP_DIR%" 2>nul

echo [INFO] 复制项目文件到临时目录...

REM 复制 Dockerfile.hf → 临时目录/Dockerfile（不覆盖项目目录的 Dockerfile）
copy /Y "%PROJECT_DIR%\Dockerfile.hf" "%TMP_DIR%\Dockerfile" >nul 2>&1
if not errorlevel 1 (
    echo [INFO]   ^✓ Dockerfile ^(from Dockerfile.hf^)
) else (
    echo [WARN]   ✗ Dockerfile.hf ^(不存在，跳过^)
)

REM 复制 README.hf.md → 临时目录/README.md（HF Space 配置）
copy /Y "%PROJECT_DIR%\README.hf.md" "%TMP_DIR%\README.md" >nul 2>&1
if not errorlevel 1 (
    echo [INFO]   ^✓ README.md ^(from README.hf.md^)
) else (
    echo [WARN]   ✗ README.hf.md ^(不存在，跳过^)
)

xcopy /E /I /Y "%PROJECT_DIR%\src" "%TMP_DIR%\src" >nul 2>&1
if not errorlevel 1 (
    echo [INFO]   ^✓ src
) else (
    echo [WARN]   ✗ src ^(不存在，跳过^)
)

xcopy /E /I /Y "%PROJECT_DIR%\assets" "%TMP_DIR%\assets" >nul 2>&1
if not errorlevel 1 (
    echo [INFO]   ^✓ assets
) else (
    echo [WARN]   ✗ assets ^(不存在，跳过^)
)

REM 只复制 entrypoint.sh，不复制部署脚本
mkdir "%TMP_DIR%\scripts" 2>nul
copy /Y "%PROJECT_DIR%\scripts\entrypoint.sh" "%TMP_DIR%\scripts\" >nul 2>&1
if not errorlevel 1 (
    echo [INFO]   ^✓ scripts\entrypoint.sh
) else (
    echo [WARN]   ✗ scripts\entrypoint.sh ^(不存在，跳过^)
)

copy /Y "%PROJECT_DIR%\package.json" "%TMP_DIR%\" >nul 2>&1
if not errorlevel 1 echo [INFO]   ^✓ package.json

copy /Y "%PROJECT_DIR%\pnpm-lock.yaml" "%TMP_DIR%\" >nul 2>&1
if not errorlevel 1 echo [INFO]   ^✓ pnpm-lock.yaml

copy /Y "%PROJECT_DIR%\tsconfig.json" "%TMP_DIR%\" >nul 2>&1
if not errorlevel 1 echo [INFO]   ^✓ tsconfig.json

if exist "%PROJECT_DIR%\.dockerignore" (
    copy /Y "%PROJECT_DIR%\.dockerignore" "%TMP_DIR%\" >nul 2>&1
    echo [INFO]   ^✓ .dockerignore
) else (
    (
        echo node_modules/
        echo dist/
        echo .git/
        echo .env
        echo .env.*
        echo *.log
        echo *.md
        echo .vscode/
        echo .idea/
        echo coverage/
        echo test/
    ) > "%TMP_DIR%\.dockerignore"
    echo [INFO]   ^✓ .dockerignore ^(生成^)
)

echo.

REM ========== 验证临时目录 ==========
set "FILE_COUNT=0"
for %%f in ("%TMP_DIR%\*") do set /a FILE_COUNT+=1
if %FILE_COUNT%==0 (
    echo [ERROR] 临时目录为空，没有任何文件被复制
    pause
    exit /b 1
)
echo [INFO] 共复制 %FILE_COUNT% 个文件到临时目录
echo.

REM ========== 3. 初始化 Git 并推送 ==========
cd /d "%TMP_DIR%"

git init 2>nul
git config user.name "%HF_USERNAME%"
git config user.email "%HF_USERNAME%@users.huggingface.co"
git remote add origin "https://%HF_USERNAME%:%HF_TOKEN%@huggingface.co/spaces/%HF_USERNAME%/%HF_SPACE_NAME%" 2>nul

git checkout -b main
git add -A
git commit -m "deploy: %date:~0,4%-%date:~5,2%-%date:~8,2%T%time:~0,2%:%time:~3,2%:%time:~6,2%Z" 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] git commit 失败
    echo [ERROR] 当前目录: %CD%
    echo [ERROR] 目录内容:
    dir /a
    echo [ERROR] git status:
    git status
    pause
    exit /b 1
)

echo [INFO] 推送至: https://huggingface.co/spaces/%HF_USERNAME%/%HF_SPACE_NAME%
echo [INFO] 正在推送...
echo.

git push -u origin main --force 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] 推送失败，请检查 HF_TOKEN / HF_USERNAME / HF_SPACE_NAME 是否正确
    cd /d "%PROJECT_DIR%"
    rmdir /S /Q "%TMP_DIR%" 2>nul
    pause
    exit /b 1
)

echo.
echo [OK] 代码推送成功！
echo [OK] Space 地址: https://huggingface.co/spaces/%HF_USERNAME%/%HF_SPACE_NAME%
echo.

REM ========== 4. 设置 GEMINI_API_KEY Secret ==========
echo [INFO] 设置 GEMINI_API_KEY Secret...
curl -s -X POST "https://huggingface.co/api/spaces/%HF_USERNAME%/%HF_SPACE_NAME%/secrets" ^
  -H "Authorization: Bearer %HF_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"key\": \"GEMINI_API_KEY\", \"value\": \"%GEMINI_API_KEY%\"}" >nul 2>&1
if not errorlevel 1 (
    echo [OK]  ^✓ GEMINI_API_KEY Secret 已设置
) else (
    echo [WARN]  ^⚠ GEMINI_API_KEY Secret 设置失败
    echo [WARN]  请手动在 HF Space Settings → Repository secrets 中添加
)

echo.
echo [OK] 部署完成！
echo.

REM ========== 清理 ==========
cd /d "%PROJECT_DIR%"
rmdir /S /Q "%TMP_DIR%" 2>nul

pause
exit /b 0
