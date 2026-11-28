param(
    [Parameter(Mandatory)] [string] $JavaHome,
    [Parameter(Mandatory)] [string] $BuildTools,
    [Parameter(Mandatory)] [string] $AndroidJar,
    [string] $Keystore,
    [string] $KeyAlias = 'audora'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $root 'frontend/package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
    throw "Expected a numeric Android release version, got $version"
}
$mobileRevision = 4
$versionCode = ([int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3]) * 10 + $mobileRevision
if ($versionCode -gt 2100000000) { throw 'Android version code exceeds its supported range.' }
$version = "$version-mobile.$mobileRevision"
$exe = if ($IsWindows) { '.exe' } else { '' }
$javac = Join-Path $JavaHome "bin/javac$exe"
$java = Join-Path $JavaHome "bin/java$exe"
$jar = Join-Path $JavaHome "bin/jar$exe"
$keytool = Join-Path $JavaHome "bin/keytool$exe"
$aapt2 = Join-Path $BuildTools "aapt2$exe"
$zipalign = Join-Path $BuildTools "zipalign$exe"
$d8 = Join-Path $BuildTools 'lib/d8.jar'
$signer = Join-Path $BuildTools 'lib/apksigner.jar'
foreach ($tool in @($javac, $java, $jar, $aapt2, $zipalign, $d8, $signer, $AndroidJar)) {
    if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Android build input missing: $tool" }
}

$out = (New-Item -ItemType Directory -Force -Path (Join-Path $root '.cache/BUILD/android')).FullName
$work = (New-Item -ItemType Directory -Path (Join-Path $out ('build-' + [guid]::NewGuid().ToString('N')))).FullName
$classes = (New-Item -ItemType Directory -Path (Join-Path $work 'classes')).FullName
$dex = (New-Item -ItemType Directory -Path (Join-Path $work 'dex')).FullName
$resourceDir = (New-Item -ItemType Directory -Path (Join-Path $work 'res')).FullName
$drawable = (New-Item -ItemType Directory -Path (Join-Path $resourceDir 'drawable-nodpi')).FullName
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'res') -Directory |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $resourceDir -Recurse }
Copy-Item -LiteralPath (Join-Path $root 'frontend/assets/audoralogo.png') -Destination (Join-Path $drawable 'audora.png')

$resources = Join-Path $work 'resources.zip'
$unsigned = Join-Path $work 'unsigned.apk'
$aligned = Join-Path $work 'aligned.apk'
$classJar = Join-Path $work 'classes.jar'
$manifest = Join-Path $PSScriptRoot 'AndroidManifest.xml'
$frontend = Join-Path $root 'frontend'
$vite = Join-Path $frontend 'node_modules/vite/bin/vite.js'
if (!(Test-Path -LiteralPath $vite -PathType Leaf)) { throw 'Install the frontend dependencies with npm ci in frontend first.' }
$webRoot = Join-Path $work 'web'
$webAssets = Join-Path $webRoot 'assets'
Push-Location -LiteralPath $frontend
try {
    & node $vite build --config vite.android.config.ts --outDir $webAssets
} finally {
    Pop-Location
}

$generated = (New-Item -ItemType Directory -Path (Join-Path $work 'gen')).FullName
& $aapt2 compile --dir $resourceDir -o $resources
& $aapt2 link --manifest $manifest --version-name $version --version-code $versionCode -I $AndroidJar --java $generated -o $unsigned $resources
$sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src'), $generated -Recurse -File -Filter '*.java' |
    Select-Object -ExpandProperty FullName
# jar writes portable ZIP entry names for nested assets on Windows.
& $jar --update --file $unsigned -C $webRoot assets
& $javac --release 8 -encoding UTF-8 -classpath $AndroidJar -d $classes @sources
& $jar --create --file $classJar -C $classes .
& $java -cp $d8 com.android.tools.r8.D8 --lib $AndroidJar --min-api 26 --output $dex $classJar
& $jar --update --file $unsigned -C $dex classes.dex
& $zipalign -f 4 $unsigned $aligned

if ($Keystore) {
    if (!$env:AUDORA_ANDROID_KEYSTORE_PASSWORD) { throw 'Set AUDORA_ANDROID_KEYSTORE_PASSWORD for release signing.' }
    $Keystore = (Resolve-Path -LiteralPath $Keystore).Path
    $signing = @('--ks-pass', 'env:AUDORA_ANDROID_KEYSTORE_PASSWORD')
    if ($env:AUDORA_ANDROID_KEY_PASSWORD) { $signing += @('--key-pass', 'env:AUDORA_ANDROID_KEY_PASSWORD') }
    $suffix = ''
} else {
    # The local QA certificate is for sideload testing and is never checked in.
    $Keystore = Join-Path $out 'audora-qa.p12'
    $KeyAlias = 'audora-qa'
    if (!(Test-Path -LiteralPath $Keystore)) {
        & $keytool -genkeypair -storetype PKCS12 -keystore $Keystore -alias $KeyAlias -keyalg RSA `
            -keysize 2048 -validity 10000 -storepass android -dname 'CN=Audora Local QA'
    }
    $signing = @('--ks-pass', 'pass:android')
    $suffix = '-qa'
}

$signed = Join-Path $work 'signed.apk'
& $java -jar $signer sign --ks $Keystore --ks-key-alias $KeyAlias @signing --out $signed $aligned
& $java -jar $signer verify $signed
& $zipalign -c 4 $signed
$apk = Join-Path $out "Audora-Android-$version$suffix.apk"
Move-Item -LiteralPath $signed -Destination $apk -Force
Write-Output "Android APK: $apk"
