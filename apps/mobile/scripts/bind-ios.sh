#!/usr/bin/env sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "iOS binding requires macOS and Xcode." >&2
  exit 1
fi
xcrun --sdk iphoneos --show-sdk-version
xcrun --sdk iphonesimulator --show-sdk-version
export PATH="$(go env GOPATH)/bin:$PATH"
command -v gobind >/dev/null
command -v gomobile >/dev/null
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/../engine"
gomobile bind -target=ios -iosversion=16.4 -o ../modules/engine/ios/BetterBuyEngineKit.xcframework .
