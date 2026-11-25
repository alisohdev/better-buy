$ErrorActionPreference = "Stop"
if (!$env:ANDROID_HOME -or !$env:JAVA_HOME) {
  throw "Set ANDROID_HOME and JAVA_HOME for this shell."
}
$env:ANDROID_NDK_HOME = Join-Path $env:ANDROID_HOME "ndk/27.1.12297006"
if (!(Test-Path (Join-Path $env:ANDROID_NDK_HOME "source.properties"))) {
  throw "Install Android NDK 27.1.12297006."
}
$goBin = Join-Path (go env GOPATH) "bin"
$env:Path = "$env:JAVA_HOME/bin;$goBin;$env:Path"
$engineDir = Join-Path $PSScriptRoot "../engine"
$artifacts = New-Item -Force -ItemType Directory (Join-Path $PSScriptRoot "../modules/engine/android/libs")
Push-Location $engineDir
try {
  gomobile bind "-target=android/arm64,android/amd64" -androidapi=24 '-ldflags=-extldflags=-Wl,-z,max-page-size=16384' -o (Join-Path $artifacts.FullName "betterbuyengine.aar") .
  if ($LASTEXITCODE -ne 0) { throw "GoMobile Android binding failed." }
} finally {
  Pop-Location
}
