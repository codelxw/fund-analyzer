# One-click APK build (command line only, no Android Studio needed)
# Builds in an ASCII temp dir to avoid non-ASCII path issues, then copies
# the final APK back to the project folder.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
$tools = if ($env:GFC_TOOLS) { $env:GFC_TOOLS } else { 'C:\Users\lxw\AppData\Local\gfc-tools' }
$sdk = Join-Path $tools 'android-sdk'
$jdk = Join-Path $tools 'jdk17'
$bt = Join-Path $sdk 'build-tools\35.0.0'
$androidJar = Join-Path $sdk 'platforms\android-35\android.jar'

$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;" + $env:Path

if (-not (Test-Path -LiteralPath $bt)) { throw "build-tools not found: $bt" }

$root = Split-Path -Parent $PSScriptRoot
$androidDir = $PSScriptRoot

# staging dir with ASCII-only path
$stageBase = Join-Path $env:LOCALAPPDATA 'gfc-build'
$stage = Join-Path $stageBase 'app'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item -LiteralPath (Join-Path $androidDir 'AndroidManifest.xml') -Destination $stage
$srcDir = Join-Path $stage 'src\com\gfc\dashboard'
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
Copy-Item -LiteralPath (Join-Path $androidDir 'src\com\gfc\dashboard\MainActivity.java') -Destination $srcDir
Copy-Item -LiteralPath (Join-Path $androidDir 'icon-source.png') -Destination (Join-Path $stage 'icon-source.png')

$www = Join-Path $stage 'assets\www'
New-Item -ItemType Directory -Force -Path $www | Out-Null
foreach ($f in @('index.html', 'app.js', 'style.css', 'funds.js', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png')) {
    Copy-Item -LiteralPath (Join-Path $root $f) -Destination $www -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $www 'vendor') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'vendor\echarts.min.js') -Destination (Join-Path $www 'vendor') -Force

$ks = Join-Path $androidDir 'gfc.keystore'
$stageKs = Join-Path $stage 'gfc.keystore'
if (Test-Path -LiteralPath $ks) { Copy-Item -LiteralPath $ks -Destination $stageKs }

Add-Type -AssemblyName System.Drawing
function New-IconFromSource([string]$src, [int]$size, [string]$out) {
    $img = [System.Drawing.Image]::FromFile($src)
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $img.Dispose()
}
$iconSizes = @{ 'mipmap-mdpi' = 48; 'mipmap-hdpi' = 72; 'mipmap-xhdpi' = 96; 'mipmap-xxhdpi' = 144; 'mipmap-xxxhdpi' = 192 }
foreach ($k in $iconSizes.Keys) {
    $dir = Join-Path $stage ("res\" + $k)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    New-IconFromSource (Join-Path $stage 'icon-source.png') $iconSizes[$k] (Join-Path $dir 'ic_launcher.png')
}

function Invoke-Checked {
    param([scriptblock]$Block, [string]$What)
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "Step failed: $What (exit code $LASTEXITCODE)" }
}

$work = Join-Path $stage 'build'
New-Item -ItemType Directory -Force -Path $work | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $work 'dexout') | Out-Null
Push-Location $stage
try {
    Invoke-Checked { & (Join-Path $bt 'aapt2.exe') compile --dir (Join-Path $stage 'res') -o (Join-Path $work 'res.zip') } 'aapt2 compile'
    Invoke-Checked {
        & (Join-Path $bt 'aapt2.exe') link -o (Join-Path $work 'base.apk') `
            -I $androidJar `
            --manifest (Join-Path $stage 'AndroidManifest.xml') `
            -R (Join-Path $work 'res.zip') `
            --auto-add-overlay
    } 'aapt2 link'

    Invoke-Checked { & (Join-Path $jdk 'bin\javac.exe') --release 8 -encoding UTF-8 -cp $androidJar -d (Join-Path $work 'classes') (Join-Path $srcDir 'MainActivity.java') } 'javac'
    $classes = Get-ChildItem -LiteralPath (Join-Path $work 'classes') -Recurse -Filter '*.class' | ForEach-Object { $_.FullName }
    Invoke-Checked { & (Join-Path $bt 'd8.bat') --release --lib $androidJar --min-api 24 --output (Join-Path $work 'dexout') $classes } 'd8'

    Invoke-Checked { & (Join-Path $jdk 'bin\jar.exe') uf (Join-Path $work 'base.apk') -C (Join-Path $work 'dexout') classes.dex } 'jar add dex'
    Invoke-Checked { & (Join-Path $jdk 'bin\jar.exe') uf (Join-Path $work 'base.apk') -C $stage assets } 'jar add assets'

    Invoke-Checked { & (Join-Path $bt 'zipalign.exe') -f 4 (Join-Path $work 'base.apk') (Join-Path $work 'aligned.apk') } 'zipalign'

    if (-not (Test-Path -LiteralPath $stageKs)) {
        Invoke-Checked { & (Join-Path $jdk 'bin\keytool.exe') -genkeypair -keystore $stageKs -alias gfc -keyalg RSA -keysize 2048 -validity 10950 -storepass gfc2026 -keypass gfc2026 -dname 'CN=GFC, OU=GFC, O=GFC, L=BJ, ST=BJ, C=CN' } 'keytool'
    }
    $stageApk = Join-Path $stage 'GlobalFundBoard-v1.3.apk'
    Invoke-Checked { & (Join-Path $bt 'apksigner.bat') sign --ks $stageKs --ks-pass pass:gfc2026 --key-pass pass:gfc2026 --out $stageApk (Join-Path $work 'aligned.apk') } 'apksigner sign'

    Invoke-Checked { & (Join-Path $bt 'apksigner.bat') verify --print-certs $stageApk } 'apksigner verify'
    Invoke-Checked { & (Join-Path $bt 'aapt2.exe') dump badging $stageApk } 'aapt2 badging'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($stageApk)
    try {
        $names = @($zip.Entries | ForEach-Object { $_.FullName })
        foreach ($need in @('classes.dex', 'assets/www/index.html', 'assets/www/app.js', 'assets/www/vendor/echarts.min.js', 'AndroidManifest.xml')) {
            if ($names -notcontains $need) { throw "APK missing entry: $need" }
        }
        if (-not ($names -match '^res/mipmap-xxxhdpi(-v\d+)?/ic_launcher\.png$')) { throw 'APK missing launcher icon' }
    } finally { $zip.Dispose() }

    Copy-Item -LiteralPath $stageKs -Destination $ks -Force -ErrorAction SilentlyContinue
    $apkName = -join ([char]0x57FA, [char]0x91D1, [char]0x5206, [char]0x6790, [char]0x5668, '-v1.3.apk')
    $outApk = Join-Path $root $apkName
    Copy-Item -LiteralPath $stageApk -Destination $outApk -Force
    $mb = [math]::Round((Get-Item -LiteralPath $outApk).Length / 1MB, 2)
    Write-Host ''
    Write-Host ('BUILD OK: ' + $outApk + ' (' + $mb + ' MB)')
}
finally {
    Pop-Location
}
