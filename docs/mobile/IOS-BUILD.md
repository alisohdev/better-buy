# iOS build feasibility (M0.1)

**Decision: iOS native compilation, simulator launch, and physical-device testing are blocked on this host.** Source inspection and Objective-C binding generation passed. No cloud build was submitted. No Apple signing, simulator, or device was used. No source change is required from this inspection.

This note does not change `docs/mobile/M0-feasibility-report.md` or the app.

Evidence labels used below:

| Label              | Meaning                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| Source inspection  | Read from this repo or from the pinned Go module cache.                        |
| Binding generation | `gobind` wrote Objective-C sources on Windows. This is not a native library.   |
| Native compilation | `gomobile bind` produced `BetterBuyEngineKit.xcframework` with Xcode. Not run. |
| Simulator launch   | A simulator booted and opened this app. Not run.                               |
| Physical device    | A signed build installed on an iPhone with Developer Mode. Not run.            |

## Host result

Checked on 2026-11-25.

| Check        | Result                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OS           | Microsoft Windows NT 10.0.26300.0. `uname` and `sw_vers` are absent.                                                                             |
| Go           | `go1.27.3 windows/amd64`.                                                                                                                        |
| Pinned tools | `C:\Users\soheili\go\bin\gomobile.exe` and `gobind.exe` are `golang.org/x/mobile` `v0.0.0-20261117202452-47699113848a`.                          |
| Xcode        | `xcrun` and `xcodebuild` are not on `PATH`.                                                                                                      |
| Unix shell   | `sh` is not on `PATH`, so `apps/mobile/scripts/bind-ios.sh` was not executed. Its first check rejects any host whose `uname -s` is not `Darwin`. |

Command that was run from `apps/mobile/engine`:

```text
gomobile bind -target=ios -iosversion=16.4 -o ..\modules\engine\ios\BetterBuyEngineKit.xcframework .
```

Result: exit 1, `gomobile: -target="ios" requires Xcode`. The XCFramework was not created. `apps/mobile/.gitignore` ignores `modules/engine/ios/*.xcframework/`, so the artifact is produced on the Mac and is not committed.

## Names, import, and symbols

Source inspection of the pinned `cmd/gomobile/bind_iosapp.go`, plus binding generation.

`bind-ios.sh` runs:

```sh
gomobile bind -target=ios -iosversion=16.4 -o ../modules/engine/ios/BetterBuyEngineKit.xcframework .
```

from `apps/mobile/engine`, whose Go package is `mobileengine`. With that `-o` path, GoMobile sets the framework title to the file stem `BetterBuyEngineKit`. The generated `module.modulemap` is `framework module "BetterBuyEngineKit"`. The Swift file imports that module. The podspec vendors the same filename. Those three names agree.

The Objective-C prefix is separate. `-prefix` is empty, so gobind uses the package name with its first letter capitalized: `Mobileengine`. `func New() *Engine` does not match gobind's constructor pattern `New` + type name (`NewEngine`), so it is exported as a free function, and the class also receives a default `init`.

Generated on this host with the engine module's tool directive:

```text
go tool gobind -lang=objc -outdir <temp> .
```

`Mobileengine.objc.h` contains:

```objc
@interface MobileengineEngine : NSObject
- (void)cancel;
- (NSString* _Nonnull)controlledError;
- (NSString* _Nonnull)logs;
- (NSString* _Nonnull)start;
- (NSString* _Nonnull)status;
- (NSString* _Nonnull)version;
@end
FOUNDATION_EXPORT MobileengineEngine* _Nullable MobileengineNew(void);
```

`BetterBuyEngineModule.swift` calls `MobileengineNew()!` and `version`, `start`, `status`, `cancel`, `logs`, and `controlledError`. Those selectors match. None of the Go methods returns `error`, so the Swift calls are not throwing. The force-unwrap matches the `_Nullable` return. Go `New` always returns a pointer; a nil here would be a gobind failure.

The umbrella header `BetterBuyEngineKit.h` includes `Mobileengine.objc.h`, `Universe.objc.h`, and `ref.h`. That header is written only while creating the framework, so it was not generated on Windows. The template in `bind_iosapp.go` is the source for that statement.

`-iosversion=16.4` becomes the clang flags `-miphoneos-version-min=16.4` and `-mios-simulator-version-min=16.4`. It does not change the framework `Info.plist`. GoMobile writes `MinimumOSVersion` `100.0` on purpose, as a static-framework embedding workaround. The podspec deployment target `16.4` is the app floor. Confirm on the first Xcode link that the app links the static archive and does not embed the framework as a dylib that the device then rejects.

## Architectures

Source inspection of `parseBuildTarget` and `platformArchs` in the pinned module. `build_test.go` expects `-target=ios` to expand to `ios/arm64,iossimulator/arm64,iossimulator/amd64`. The exact-string special case adds the simulator platform only when the target is `ios`, which is what the script passes.

| Slice     | GOARCH | Clang arch | SDK             |
| --------- | ------ | ---------- | --------------- |
| Device    | arm64  | arm64      | iphoneos        |
| Simulator | arm64  | arm64      | iphonesimulator |
| Simulator | amd64  | x86_64     | iphonesimulator |

The two simulator architectures are lipo'd into one `BetterBuyEngineKit.framework`. `xcodebuild -create-xcframework` then packs that framework with the device framework. Expected XCFramework library identifiers, not yet observed on disk:

- `ios-arm64`
- `ios-arm64_x86_64-simulator`

There is no 32-bit device slice. Passing `-target=ios/arm64` alone would drop the simulator slices and break a simulator link. Keep `-target=ios`.

## Build order

Source inspection. Expo autolinking searches `./modules` by default ([Autolinking](https://docs.expo.dev/modules/autolinking/)). `apps/mobile/modules/engine/expo-module.config.json` lists platform `apple` and class `BetterBuyEngineModule`, which is the Swift class. The podspec sits in the module's `ios/` directory, which is where `expo-modules-autolinking resolve --platform apple` looks.

CocoaPods resolves `s.vendored_frameworks = 'BetterBuyEngineKit.xcframework'` when `pod install` runs. The path is gitignored, so the framework has to exist before that install.

Local order on a Mac:

1. Install JS dependencies from the repo root (`pnpm-workspace.yaml` includes `apps/mobile`).
2. Install the pinned `gomobile` and `gobind`.
3. Run `sh apps/mobile/scripts/bind-ios.sh`.
4. Generate the iOS project. `expo prebuild` installs pods unless `--no-install` is set, so prefer `--no-install` and install pods yourself after step 3.
5. `pod install` in `apps/mobile/ios`.
6. `pnpm --filter @better-buy/mobile exec expo run:ios` for a simulator dev client. The app script is `expo run:ios`, and `start` is `expo start --dev-client`. Expo Go does not load this local module.

`eas-build-post-install` is too late. [iOS build process](https://docs.expo.dev/build-reference/ios-builds/) runs it after `pod install`. [Lifecycle hooks](https://docs.expo.dev/build-reference/npm-hooks/) say the iOS post-install hook runs after npm install, prebuild, and `pod install`. `eas-build-pre-install` runs before npm install, which is early enough for the file, and it is still the wrong place to document the CocoaPods order.

`eas/build` cannot take a custom step in the middle. The [custom build schema](https://docs.expo.dev/custom-builds/schema/) says that function is not configurable. For a simulator profile the expanded order is checkout, npm token, install node modules, resolve build config, `eas/prebuild`, `pod install`, then gym. Generate the XCFramework after checkout and before `eas/prebuild`, so it is on disk even if prebuild itself installs pods. Whether `eas/prebuild` passes `--no-install` was not checked against the eas-cli source in this session.

## macOS, Xcode, and signing

Current docs, not a local run.

[Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/) requires iOS 16.4+ and Xcode 26.4+. [Xcode 26.4 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_4-release-notes) say Xcode 26.4 includes Swift 6.3 and the iOS 26.4 SDK, supports debugging on iOS 15 and later, and requires macOS Tahoe 26.2 or later.

The Expo Build image alias `sdk-56` is `macos-tahoe-26.4-xcode-26.4`: macOS Tahoe 26.4.1, Xcode 26.4 (17E202), CocoaPods 1.16.2, Ruby 3.2, Node.js 22.22.2, pnpm 10.33.3, fastlane 2.233.1 ([infrastructure](https://docs.expo.dev/build-reference/infrastructure/)). That image list does not include Go. A custom build has to install Go 1.27.3 itself. The image is an Apple silicon Mac, so use the `darwin-arm64` Go archive.

Local Xcode setup from [iOS Simulator](https://docs.expo.dev/workflow/ios-simulator/):

- Install Xcode 26.4 or newer from the Mac App Store. For SDK 56 parity, use 26.4 rather than the Xcode 27 images.
- Xcode Settings, Locations: select the Xcode 26.4 Command Line Tools.
- Xcode Settings, Components: download the iOS platform.
- Accept the license (`sudo xcodebuild -license accept`) and run `xcodebuild -runFirstLaunch`.
- Watchman is not required on SDK 56.
- On Xcode 26 the simulator app is Simulator (`open -a Simulator`). Device Hub replaces it in Xcode 27.

Signing, from [Running your app on simulated or physical devices](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices), [TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles), and [Enabling Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device):

- A simulator build does not use a provisioning profile and does not prove signing or device execution.
- A physical device needs an Apple team in Xcode Settings, Accounts, automatic signing, and a development provisioning profile whose App ID matches `ir.betterbuy.enginelab` and whose device list contains that iPhone. The profile authorizes the signing certificate, the bundle id, and the device.
- iOS 16 and later require Developer Mode before a locally signed build will run. Pair the phone from Xcode's Device Hub (Xcode, Open Developer Tool, Device Hub), then on the phone open Settings, Privacy & Security, Developer Mode, and restart. [Expo's Developer Mode guide](https://docs.expo.dev/guides/ios-developer-mode/) matches that, and it does not apply to the simulator.
- An internal or ad hoc install is limited to the registered device identifiers in the profile. An App Store profile has no device list and is not a local run destination.

No certificate, team id, or provisioning profile is stored in this repo. Do not create one for M0.1 until a Mac is available, and do not submit the result.

## Commands on a Mac

Every step in this section is unverified. This host cannot run them.

```sh
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
xcrun --sdk iphonesimulator --show-sdk-version

cd <repo>
pnpm install --frozen-lockfile
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261117202452-47699113848a
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261117202452-47699113848a
export PATH="$(go env GOPATH)/bin:$PATH"
sh apps/mobile/scripts/bind-ios.sh

# Native compilation evidence, still not a simulator launch:
plutil -p apps/mobile/modules/engine/ios/BetterBuyEngineKit.xcframework/Info.plist
find apps/mobile/modules/engine/ios/BetterBuyEngineKit.xcframework -type f -name BetterBuyEngineKit -exec lipo -info {} \;

cd apps/mobile
pnpm exec expo prebuild --platform ios --no-install --template expo-template-bare-minimum@56.0.38
cd ios && pod install && cd ..
pnpm exec expo run:ios
```

After the `.app` is installed, boot is still not proof that the Go engine ran. In the dev client, run one fixture scan and read the diagnostics. That step is also unverified.

A device build, only after the simulator link succeeds:

```sh
pnpm exec expo run:ios --device
```

That command needs the signing setup above. It was not run.

## EAS custom build

Proposed configuration only. It was not written into the repo and `eas build` was not run.

Use image `sdk-56`. Set `ios.simulator` to `true` so Expo Build uses the simulator path and does not require Apple credentials ([eas.json simulator](https://docs.expo.dev/eas/json/), [custom build schema](https://docs.expo.dev/custom-builds/schema/)). Point `ios.config` at a YAML file under `.eas/build/`.

The YAML must install Go, run `bind-ios.sh`, and only then prebuild and install pods. Sketch, with the monorepo paths from this repo:

```yaml
build:
  name: iOS simulator, generate BetterBuyEngineKit before pods
  steps:
    - eas/checkout
    - eas/install_node_modules
    - run:
        name: Pinned Go and BetterBuyEngineKit.xcframework
        command: |
          set -euo pipefail
          curl -fsSL "https://go.dev/dl/go1.27.3.darwin-arm64.tar.gz" -o /tmp/go.tgz
          sudo rm -rf /usr/local/go
          sudo tar -C /usr/local -xzf /tmp/go.tgz
          export PATH="/usr/local/go/bin:$(/usr/local/go/bin/go env GOPATH)/bin:$PATH"
          go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261117202452-47699113848a
          go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261117202452-47699113848a
          sh apps/mobile/scripts/bind-ios.sh
    - eas/prebuild
    - run:
        name: Install pods after the XCFramework exists
        working_directory: apps/mobile/ios
        command: pod install
    - eas/generate_gymfile_from_template
    - eas/run_fastlane
    - eas/find_and_upload_build_artifacts
```

`working_directory` and the Node install step assume the Expo project root EAS is given. This app lives at `apps/mobile` inside a pnpm workspace. Set that project root when EAS is configured, and keep the `sh` path valid from the directory EAS checks out. That layout was not executed.

A later device profile adds `eas/resolve_apple_team_id_from_credentials`, `eas/configure_ios_credentials`, and `eas/configure_ios_version` around prebuild, as in the credentialed iOS list in the custom build schema. Leave that profile unused until a simulator artifact exists. A simulator archive still would not be a physical-device test.

## Code

No patch. The Swift import, the free function `MobileengineNew`, and the six method selectors match this Go package and this GoMobile revision.

If the first Mac `pod install` or link fails, record the error before editing. The likely follow-ups, none of which were compiled, are:

- Missing XCFramework: the bind script did not run before `pod install`.
- Static framework rejected by a dynamic pod: add `s.static_framework = true` to `BetterBuyEngine.podspec`.
- App embeds the framework and then refuses to launch: the generated `MinimumOSVersion` is `100.0`. Link the static archive. Do not add the XCFramework to an Embed Frameworks phase.
- Wrong or extra `gomobile` on `PATH`: the script trusts whatever `gomobile` it finds after prepending `$(go env GOPATH)/bin`. Install the pinned revision in that directory first, as in the commands above.

## What remains unverified

- `bind-ios.sh` exit status on macOS, SDK version lines, and the XCFramework bytes.
- `lipo` architectures and the XCFramework `Info.plist` library identifiers.
- `expo prebuild`, `pod install`, and the Swift compile of `BetterBuyEngineModule.swift`.
- Simulator install and launch, including Expo's dev client rather than Expo Go.
- Any call from the dev client into `MobileengineNew`.
- Signing, Developer Mode, and a physical-device install.
- The EAS YAML, Go installation on the `sdk-56` image, and credentialed device builds.
