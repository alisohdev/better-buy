param([Parameter(Mandatory)][string] $WorkDir)
$ErrorActionPreference = 'Stop'
function Run([string] $Executable, [string[]] $Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Executable exited with $LASTEXITCODE" }
}
if (!$env:JAVA_HOME -or !$env:ANDROID_HOME) { throw 'Set JAVA_HOME and ANDROID_HOME.' }
$work = (New-Item -Force -ItemType Directory $WorkDir).FullName
$j = Join-Path $env:JAVA_HOME bin
$b = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
$sdk = Join-Path $env:ANDROID_HOME 'platforms/android-36/android.jar'
$aar = (Resolve-Path (Join-Path $PSScriptRoot '../../modules/engine/android/libs/betterbuyengine.aar')).Path
New-Item -Force -ItemType Directory "$work/classes","$work/dex" | Out-Null
Run tar @('-xf',$aar,'-C',$work)
Run "$j/javac.exe" @('--release','8','-cp',"$sdk;$work/classes.jar",'-d',"$work/classes","$PSScriptRoot/Smoke.java")
Run "$b/d8.bat" @('--min-api','24','--lib',$sdk,'--output',"$work/dex","$work/classes/ir/betterbuy/gosmoke/Smoke.class","$work/classes.jar")
Run "$b/aapt.exe" @('package','-f','-M',"$PSScriptRoot/AndroidManifest.xml",'-I',$sdk,'-F',"$work/unsigned.apk")
foreach($abi in @('x86_64','arm64-v8a')) {
  New-Item -Force -ItemType Directory "$work/dex/lib/$abi" | Out-Null
  Copy-Item -LiteralPath "$work/jni/$abi/libgojni.so" -Destination "$work/dex/lib/$abi/libgojni.so" -Force
}
Run "$j/jar.exe" @('uf',"$work/unsigned.apk",'-C',"$work/dex",'classes.dex','-C',"$work/dex",'lib')
Run "$b/zipalign.exe" @('-f','4',"$work/unsigned.apk","$work/aligned.apk")
if (!(Test-Path "$work/debug.jks")) {
  Run "$j/keytool.exe" @('-genkeypair','-keystore',"$work/debug.jks",'-storepass','android','-keypass','android','-alias','androiddebugkey','-dname','CN=Android Debug','-keyalg','RSA','-validity','10000')
}
Run "$b/apksigner.bat" @('sign','--ks',"$work/debug.jks",'--ks-pass','pass:android','--out',"$work/smoke.apk","$work/aligned.apk")
Run $adb @('install','-r',"$work/smoke.apk")
$output = & $adb shell am instrument -w ir.betterbuy.gosmoke/.Smoke
$output
if ($LASTEXITCODE -ne 0 -or (($output -join ' ') -notmatch 'PASS Go JNI')) {
  throw 'Native fixture instrumentation failed.'
}
