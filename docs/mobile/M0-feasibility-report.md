# Mobile M0 feasibility report

**Decision: hold M0.** The compiled Go engine passed Android emulator tests through JNI in M0.1. The x86_64 Expo development APK built and installed. The full Expo fixture path ran on the x86_64 Android emulator. Physical ARM64 verification remains open. iOS is outside the V1 acceptance scope.

## Verified toolchain selection

| Area                      | Selection and evidence                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expo, React Native, React | Stable Expo 56.0.24, React Native 0.85.3 and React 19.2.3. The pinned Expo package manifest pairs these versions with Router 56.2.22, SQLite 56.0.6 and dev client 56.0.28. Expo Modules Core resolved to 56.0.27. Node 24.19.0 and pnpm 10.12.1 were available.                                              |
| Go                        | Go 1.27.3 on Windows amd64. GoMobile uses pinned x/mobile revision v0.0.0-20261117202452-47699113848a. Java and Objective-C bindings generated from this revision.                                                                                                                                            |
| Android                   | React Native 0.85.3 Gradle catalog records min SDK 24, compile/target SDK 36, NDK 27.1.12297006, and Kotlin 2.1.20. Use JDK 17 as recommended for Android development, plus platform tools and an SDK 36 device or emulator. The installed catalog is configuration evidence; native compilation was blocked. |
| iOS                       | Expo SDK 56 documents iOS 16.4+ and Xcode 26.4+. Use the Swift compiler bundled with that Xcode toolchain and CocoaPods. No Swift/Xcode version was executable on Windows. Use macOS for the local build. EAS is an option only after integrating native artifact generation into its build lifecycle.        |
| Sentry and notifications  | Expo's bundled manifest lists Sentry ~7.11.0 and Expo Notifications ~56.0.26. No monitoring configuration was present; neither library is enabled or verified on a device.                                                                                                                                    |

Official references: [Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/), [Android/iOS environment setup](https://docs.expo.dev/get-started/set-up-your-environment/), [Expo Modules API](https://docs.expo.dev/modules/module-api/), [Expo SQLite](https://docs.expo.dev/versions/v56.0.0/sdk/sqlite/), [GoMobile](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile), [Sentry for Expo](https://docs.expo.dev/guides/using-sentry/).

## Results

- **Passed:** Full existing Go API suite; fixture-engine unit test covering exclusive start, cancellation, a subsequent successful scan, offer normalization, metrics, and controlled error. A separate test verifies bounded export fields. Engine coverage was 98.3%. TypeScript typecheck passed.
- **Passed at package level:** `CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build modernc.org/sqlite` and the equivalent iOS package build from `apps/api` passed for the existing modernc.org/sqlite v1.61.0. The engine package cross-compiled in the same probe. This does not prove native library linkage, successful SQLite queries on device, or durability.
- **Passed at generation level:** GoMobile Java and Objective-C source binding generation. Android Expo prebuild, Android and iOS JavaScript bundle exports, and local module discovery for Android and iOS. The code uses asynchronous bridge calls; UI responsiveness was not measured.
- **Blocked:** GoMobile Android AAR and Expo native build require an Android SDK, NDK and JDK that were not available. No adb/emulator or physical device was available. GoMobile iOS XCFramework requires Xcode; no iOS app, simulator or device was tested. Race testing requires an enabled C compiler and was unavailable with this host configuration.
- **Unverified on device:** Bridge calls, visible progress, UI cancellation, SQLite writes and force-close restore, error display, and sharing the diagnostics. No Sentry event was sent. No live retailer request or deployment occurred.

## Reproduce on a native build host

Install Node, pnpm and Go. Use the Android toolchain above or macOS with the iOS toolchain. Put Go's bin directory on PATH.

```sh
pnpm install --frozen-lockfile
go -C apps/api test ./...
go -C apps/mobile/engine test -cover ./...
pnpm --filter @better-buy/mobile typecheck
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261117202452-47699113848a
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261117202452-47699113848a

cd apps/mobile/engine
mkdir -p ../modules/engine/android/libs
gomobile bind -target=android -androidapi=24 -o ../modules/engine/android/libs/betterbuyengine.aar .
# On macOS, generate the iOS artifact instead:
gomobile bind -target=ios -iosversion=16.4 -o ../modules/engine/ios/BetterBuyEngineKit.xcframework .
cd ..
pnpm exec expo prebuild --platform android --no-install --template expo-template-bare-minimum@56.0.38
pnpm android  # or: pnpm ios on macOS
```

Run one fixture scan, observe 0–3 progress and two normalized offers with zero requests. Stop and relaunch the app after seeing the saved scan ID and check that the ID and offers return. Start another scan and cancel before completion. Confirm the earlier snapshot remains. Trigger FIXTURE_ERROR and inspect the share payload from Export local diagnostics. Repeat on both platforms before marking M0 complete.

For iOS, use the ios platform in the prebuild command on macOS and install CocoaPods dependencies. On Windows PowerShell, use New-Item -ItemType Directory -Force in place of mkdir -p.

## M0.1 native build and device verification

The existing fixture UI is unchanged. The SQLite writer and engine polling now live under the application root provider instead of the diagnostics route. Navigation cannot stop persistence while the React root stays active. Go owns its in-memory scan state independently of route mounting. The last committed SQLite snapshot survives termination by design; an interrupted scan is not resumed and cannot be published as complete. Native runtime evidence is required to confirm these behaviors under backgrounding and force-stop.

The Android bridge rejects accidental main-thread calls and writes only state transitions, sanitized scan IDs, and engine versions to Android's bounded log buffer. TypeScript records SQLite write durations with the same Go scan ID; the latest 32 write events join the separate 32-event Go ring in local export. The export includes app and engine versions and excludes offer details, raw responses and credentials. No remote reporting SDK or transport is invoked. A future Sentry canary must be explicitly opted into, use a configured development DSN, disable default PII, and replace the outgoing event with an allowlisted diagnostic payload. Capture errors from a detached test action and never await telemetry in a scan or persistence operation.

### Windows regeneration

Use a PowerShell session with the paths below. The JDK and SDK may live in any user-writable folder. Android Studio is optional for the CLI workflow. If you prefer the IDE, Narwhal Feature Drop 2025.1.2 supports the project's AGP 8.12 per the [Android compatibility table](https://developer.android.com/build/releases/about-agp). Studio was not installed during M0.1. Its SDK Manager and Device Manager are an alternative to the command line. Avoid mixing an unrelated Studio toolchain with the pinned NDK.

```powershell
$env:JAVA_HOME = "$env:LOCALAPPDATA/BetterBuyM01/jdk-17.0.17+10"
$env:ANDROID_HOME = "$env:LOCALAPPDATA/BetterBuyM01/sdk"
$env:Path = "$env:JAVA_HOME/bin;$env:ANDROID_HOME/platform-tools;$env:Path"
$sdkManager = Join-Path $env:ANDROID_HOME 'cmdline-tools/latest/bin/sdkmanager.bat'
& $sdkManager --licenses
& $sdkManager 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 'build-tools;35.0.0' 'ndk;27.1.12297006' 'cmake;3.22.1' 'emulator' 'system-images;android-35;default;x86_64'
pnpm install --frozen-lockfile
pnpm --filter @better-buy/mobile exec expo prebuild --platform android --no-install --template expo-template-bare-minimum@56.0.38
./apps/mobile/scripts/bind-android.ps1
Push-Location apps/mobile/android
.\gradlew.bat :app:assembleDebug '-PreactNativeArchitectures=arm64-v8a,x86_64'
Pop-Location
```

Configure an x86_64 API 35 AVD in Android Studio Device Manager, or use a USB debugging-enabled ARM64 phone and accept its RSA prompt. Check `adb devices -l`, install `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`, start Metro with `pnpm --filter @better-buy/mobile start`, and use `adb reverse tcp:8081 tcp:8081` for USB or local emulator access. Open the Metro project in the development client. Use `adb shell am start -W` and `adb shell dumpsys meminfo ir.betterbuy.enginelab` for startup and memory measurements. Keep fixture logs and measured timings separate from startup to the Expo launcher. Use the diagnostics share output for Go and TypeScript data and `adb logcat -s BetterBuyEngine:I` for native transitions.

### iOS and EAS

Use macOS with the SDK 56-supported Xcode toolchain, CocoaPods and pinned Go. Run `sh apps/mobile/scripts/bind-ios.sh` to generate `BetterBuyEngineKit.xcframework` before `pod install`, then run the development build on a simulator. A physical device requires registered device provisioning and signing using the founder's Apple development team, with Developer Mode enabled. Simulator builds do not prove signing or device execution.

EAS custom iOS builds can place a pinned Go install and the XCFramework generation between checkout and CocoaPods installation. Use a pinned Xcode image, install workspace dependencies, generate the framework in the local module, prebuild, install pods, then compile with the appropriate simulator or internal device profile. The standard iOS `eas-build-post-install` hook runs after CocoaPods and is too late for this pod's vendored framework. Custom builds provide the needed ordering. No cloud job, Apple credentials, signing, simulator launch, or physical test was run. [EAS lifecycle hooks](https://docs.expo.dev/build-reference/npm-hooks/) · [EAS custom build steps](https://docs.expo.dev/custom-builds/schema/)

### Measured native evidence

- Installed user-local Microsoft OpenJDK 17.0.17, Android command-line tools 22.0, SDK Platform 36 (rev 2), Build Tools 35.0.0 and 36.0.0, NDK r27b, Android CMake 3.22.1, ADB 37.0.3, and Android Emulator 37.4.2. The project wrapper runs Gradle 9.3.1. The React Native Gradle catalog selects Kotlin 2.1.20 (Gradle itself reports embedded Kotlin 2.2.21).
- Google SDK archives were recovered from Google's distribution endpoint and verified against published checksums. Android Studio was unnecessary for the CLI workflow. No machine-wide environment variables were changed.
- The x86_64 Android 15 / API 35 AVD booted via Windows Hypervisor Platform. Its data directory is on D: because C: fell below the emulator's free-space threshold. No physical device was attached.
- The initial GoMobile AAR built at **5,193,042 bytes**. The regeneration script now uses a 16 KiB maximum page size. The rebuilt AAR is **5,194,483 bytes**; NDK ELF inspection confirmed AArch64 and x86-64 with 16 KiB LOAD alignment. The emulator uses 4 KiB pages; this does not establish whole-app compatibility on a 16 KiB device. The standalone test APK was **4,993,506 bytes** in the initial run; this is not the Expo application size.
- A standalone instrumentation APK on the emulator exercised the generated Java bindings against the real compiled Go AAR. It verified engine version, exclusive scan, cancellation with no offers, repeated scan, intermediate progress, two normalized results, zero requests, controlled error, correlated logs, and the 32-event bound. In one emulator run the fixture took **1,216 ms** and the diagnostic JSON was **836 bytes** before the bound test. The rebuilt 16 KiB-aligned AAR passed on that same 4 KiB emulator in 1,220 ms, with 835 log bytes. No physical-device measurements exist.

Reproduce just the Android JNI check with the built AAR and exactly one attached device. Reuse the working directory so the disposable debug signature stays consistent:

```powershell
./apps/mobile/scripts/android-smoke/run.ps1 -WorkDir 'D:/BetterBuyM01/repro-smoke'
```

This harness bypasses the Expo layer for isolation. It cannot establish Kotlin module execution, app startup, JS responsiveness, Expo SQLite, or sharing behavior.

### M0.1 acceptance checklist

| Check                                                                                                                                       | Status                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows toolchain, Gradle wrapper, ADB, API 35 emulator                                                                                     | Pass                                                                                                                                                                                                             |
| Android GoMobile library and both ELF architectures                                                                                         | Pass                                                                                                                                                                                                             |
| Compiled Go runs on x86_64 Android                                                                                                          | Pass via isolated JNI harness. ARM64 binary inspected; no ARM64 device attached.                                                                                                                                 |
| Engine startup, repeat scan, cancellation, intermediate progress, normalization, stable controlled error, bounded correlated Go diagnostics | Pass via JNI harness. Reproduction script also passed (1,212 ms, 832 log bytes).                                                                                                                                 |
| Expo development APK, Kotlin module execution, native background-thread assertion                                                           | APK build and install passed from the short Windows build copy. The native bridge ran in the installed app and logged mainThread=false.                                                                          |
| Expo UI responsiveness, database latency, SQLite save and restart, backgrounding, force-stop and share sheet                                | Pass for fixture interaction, cancellation, SQLite save, restart restore, background completion, force-stop during scanning, and opening the local share sheet. Peak memory and frame latency remain unmeasured. |
| Expo APK bytes, installed bytes, cold startup, idle and peak RSS/PSS                                                                        | Expo APK: 91,453,876 bytes. Installed package directory: 89,208 KiB (du, excludes app data). Startup and memory are tracked separately.                                                                          |
| Remote telemetry consent and delivery                                                                                                       | Off by design; no opted-in configuration or delivery attempt.                                                                                                                                                    |
| iOS XCFramework and simulator/physical build                                                                                                | Blocked on Windows. Mac or a configured EAS macOS workflow required.                                                                                                                                             |

The default Gradle build failed at Expo's autolinking plugin because Google Maven returned 404 for the AGP 8.5.0 POM. A session-local test against Google's alternate distribution endpoint resolved that artifact, but downstream dependency reads timed out. The next build host needs reliable access to Google Maven, Maven Central and the Gradle Plugin Portal. Retry the Windows regeneration commands on that host before measuring the Expo app. The short-path build produced the x86_64 APK. Repeat the checklist on an ARM64 phone before closing device acceptance. Android physical-device acceptance remains separate from emulator verification.

On Windows, use a short checkout or build-copy path such as `D:/bbm01`. This machine had Windows long-path support disabled, and Ninja rejected a Gesture Handler generated source path longer than 260 characters in the original checkout. Shortening only the output directory fixed repeated Ninja manifest regeneration in dependency modules, but could not shorten generated source paths. To keep CMake outputs short as well, set `$env:BETTER_BUY_CMAKE_STAGING='D:/bxc'` and add `-I ../scripts/android-short-paths.gradle` when running Gradle from `apps/mobile/android`. No registry setting was changed.

The x86_64 Expo APK built successfully in 9m 57s from D:/bbm01 using the short staging script and a session-local Google Maven mirror. The installed APK contained lib/x86_64/libgojni.so. The initial cold Activity launch took 6,593 ms, but Metro was offline during that attempt, so this is not time to a ready diagnostics screen.

### Expo application evidence, November 25

- Android 15 / API 35, x86_64 emulator with 4 KiB pages. The development APK was built from the short copy using Expo SDK 56 and Gradle 9.3.1. The native library is packaged at lib/x86_64/libgojni.so. The app reported engine 0.1.0 and its Kotlin transitions ran on a worker thread. The installed package directory occupied 89,208 KiB excluding private app data.
- The initial Metro launch failed with an HTTP stream error; a running local Metro instance from the short copy and ADB reverse restored launch. Cold Activity samples included 2,725 ms, with JavaScript startup and the developer menu outside that number. This is a development build, with no production startup claim.
- The UI showed provisional running progress, then two normalized offers (800 and 900), zero retailer requests, and completed fixture durations of 1,220 and 1,212 ms. Repeated scan and the controlled FIXTURE_ERROR passed. Tapping Cancel while collecting produced a cancelled native transition with no persistence event for that ID. A scan backgrounded via Home completed, persisted, and the app returned to the foreground.
- Kotlin and TypeScript logs matched the engine scan ID. Example SQLite writes took 10, 44, and 136 ms. The JNI harness separately verified Go log correlation, bounds and sanitized messages. Local log export is consent-driven via the share sheet. Remote telemetry remains disabled.
- One idle memory sample reported 371,034 KiB PSS / 510,200 KiB RSS. A single near-scan sample reported 366,722 KiB PSS / 506,424 KiB RSS. This sampling does not establish peak memory or a frame timing baseline. A responsive cancellation action was verified; frame latency was not measured.
- ARM64 library inspection passed, but no ARM64 app/device run or 16 KiB device run was performed. Swift source and the macOS bind script are preserved; native iOS compilation and signing still require the documented macOS environment.

A force-stop 350 ms after starting a scan left the previously committed SQLite row byte-for-byte equivalent as decoded JSON. On relaunch, the screen showed idle and restored that prior scan ID and its two offers. The Android share sheet opened and showed versioned JSON with empty event buffers after process restart. The M0.1 log buffer is intentionally process-local.

## Android-only V1 acceptance

Android is the only V1 platform. The Android emulator fixture pass remains valid. ARM64 packaging and physical-device execution are separate checks.

### Sequential fixture baseline

Twenty successive fixture scans, each with exactly one correlated SQLite write event, completed in the previously verified 91,453,876-byte x86_64 **development** APK on the API 35 Windows emulator. All ran in the same app process. ADB taps and logcat polling were used to observe terminal native transitions. They are part of the timing overhead.

| Metric                                                 | Emulator development build                     |
| ------------------------------------------------------ | ---------------------------------------------- |
| Tap to detected completion, minimum / median / maximum | 1,344 / 1,641 / 1,843 ms                       |
| SQLite write, 20 observed commits                      | 9–21 ms                                        |
| Initial idle PSS / RSS                                 | 364,931 / 499,552 KiB                          |
| Highest sampled PSS / RSS during the series            | 378,857 / 514,196 KiB                          |
| Immediately after scan 20 PSS / RSS                    | 375,879 / 511,220 KiB                          |
| Android threads before / after                         | 57 / 61                                        |
| Process CPU tick delta                                 | 1,012 user + 1,239 system                      |
| Android gfxinfo frame timing                           | 785 frames; 56.05% janky; p50 34 ms; p95 81 ms |

These are samples, not a process memory high-water mark. Native thread count cannot substitute for a Go goroutine count. The short run showed higher settled memory than its starting snapshot and does not establish a leak or rule one out. Debug mode, host load, software graphics and ADB sampling limit the frame and timing interpretation. No optimization was made from these figures.

The Go regression now exercises 20 sequential start/cancel cycles with four concurrent cancellation/status callers, checks each unique scan reaches a cancelled terminal state with no offers, and verifies the next scan can start. Three host test runs passed, and three Windows race-detector runs passed with CGO_ENABLED=1 and CC=clang. The existing lifecycle test separately checks successful normalization. A controlled error is a diagnostic action; it does not publish a successful scan. Process loss leaves the last completed snapshot and no completed result for the in-flight scan.

### Physical ARM64 phone

1. Enable Developer options by tapping the phone's Build number seven times. Enable USB debugging.
2. Connect it with a data-capable USB cable, unlock it and accept the computer's RSA prompt. If ADB cannot see it on Windows, switch the USB mode to file transfer and install the manufacturer's USB driver.
3. Use the installed platform tools from PowerShell. Substitute the phone serial shown by ADB, not emulator-5554.

```powershell
$adb = "$env:LOCALAPPDATA/BetterBuyM01/sdk/platform-tools/adb.exe"
& $adb devices -l
& $adb -s PHONE_SERIAL shell getprop ro.product.cpu.abilist
& $adb -s PHONE_SERIAL install -r PATH_TO_RELEASE_APK
& $adb -s PHONE_SERIAL shell am start -W -n ir.betterbuy.enginelab/.MainActivity
```

The release build should open without Metro. Run a fixture, cancel another, force-stop during a third, and verify the last completed result restores. Measure startup, frame timing and memory on this phone separately from emulator figures. ADB currently lists the emulator only.

### ARM64 packaging and bridge probe

The Go AAR is 5,194,483 bytes. Its uncompressed ARM64 and x86_64 libraries are 6,245,000 and 6,493,424 bytes respectively. Both ELF files were identified by machine type and have 16 KiB LOAD alignment. The existing development APK contains the stripped x86_64 library (3,350,448 bytes). Its APK size is a baseline for a single ABI with a Metro-served bundle.

On the x86_64 emulator, the dedicated JNI harness averaged 8,091 ns per idle status call over 2,000 calls after 100 warmups. This includes Go snapshot serialization and JNI string conversion. It excludes Expo scheduling, Kotlin diagnostics, and React Native parsing. An isolated Go host probe completed 20 sequential fixtures and returned to two goroutines after settling, matching the initial count. This is host evidence, not an on-device goroutine profile.

The development scan series consumed 22.51 process CPU seconds based on the emulator's 100 Hz process clock. The CPU count includes UI, JS, native threads and debug overhead; it does not isolate Go. Performance across release and production devices must be measured separately.

### Release build reproduction

Use the same pinned toolchain, regenerate the dual-ABI Go AAR, and prebuild Android as shown above. The generated Expo template uses its local debug signing configuration for the release variant, so use the resulting APK only for local measurements.

```powershell
$env:NODE_ENV = 'production'
$env:EXPO_NO_TELEMETRY = '1'
$env:EXPO_OFFLINE = '1'
$env:BETTER_BUY_CMAKE_STAGING = 'D:/bxc'
Push-Location apps/mobile/android
.\gradlew.bat -I ../scripts/android-short-paths.gradle :app:assembleRelease '-PreactNativeArchitectures=arm64-v8a,x86_64' --max-workers=4 --console=plain
Pop-Location
```

The intended output is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Inspect both ABI directories and the embedded filename `assets/index.android.bundle` before installing. Use the short-copy and Maven access notes from M0.1 if building on this Windows host. A signature conflict on an existing phone install requires the matching local key or a fresh test installation. Do not remove an existing install unless its data can be discarded.

### Android release artifact

Gradle 9.3.1 completed `:app:assembleRelease` in 29m 47s on this Windows host. Android SDK `apksigner verify` exited successfully. The locally signed artifact is `D:/bbm01/apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

| Release artifact measurement                            |      Bytes |
| ------------------------------------------------------- | ---------: |
| APK file                                                | 70,154,609 |
| `lib/arm64-v8a/libgojni.so`                             |  3,117,424 |
| `lib/x86_64/libgojni.so`                                |  3,350,448 |
| Embedded Hermes bytecode, `assets/index.android.bundle` |  2,321,628 |

The APK libraries matched the expected ARM64 and x86_64 ELF machine types. The APK stores the three measured entries uncompressed. The release APK is 21,299,267 bytes smaller (23.29%) than the 91,453,876-byte development APK. The release includes two ABIs and the embedded Hermes bundle. The development build included one ABI and loaded its JS over Metro, so the comparison describes the delivered packages.

### Android release runtime baseline

Measured on the Windows API 35 x86_64 emulator. The signed release installed and opened the fixture screen with its embedded bundle. Android reported these Activity launch times via `am start -W`; the measurements end at the system's Activity display boundary. Three cold and three warm launches were taken before the scan series.

| Measurement                    | Release emulator result                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Cold Activity startup          | 1,533 / 2,002 / 2,343 ms, sorted                                                                                          |
| Warm Activity startup          | 384 / 438 / 1,258 ms, sorted                                                                                              |
| Installed package directory    | 108,856 KiB allocated, including compiled ART files and excluding app data, measured with emulator `su 0 du -sk`          |
| Idle process memory            | 122,882 KiB PSS / 248,824 KiB RSS                                                                                         |
| Highest sampled fixture memory | 126,003 KiB PSS / 254,180 KiB RSS                                                                                         |
| Immediately after 20 scans     | 123,853 KiB PSS / 252,032 KiB RSS                                                                                         |
| Process threads                | 40 before, 41 after in the same process                                                                                   |
| Process CPU                    | 11.63 CPU seconds over 35.27 wall seconds, about 33% of one core on average                                               |
| Fixture completion             | 20 distinct completed IDs in one process, tap to observed completion 1,328 / 1,515.5 / 1,641 ms (min/median/max)          |
| Rendered frames                | 1,015 frames, 296 Android-classified janky (29.16%), p50 32 ms, p95 42 ms, p99 57 ms                                      |
| SQLite writes                  | 9–21 ms in the separate development run. Release write timings were unavailable from logcat.                              |
| Native bridge                  | About 8.1 microseconds per idle Go/JNI status call in the dedicated harness. Full Expo bridge latency remains unmeasured. |

Memory samples were taken during scans 1, 10, and 20. This sampling can miss transient peaks. The same process completed all 20 runs. The single additional process thread and small increase in settled PSS do not establish the presence or absence of a leak. The host Go probe returned to its baseline goroutine count. Device-level goroutine counts and physical-device memory remain unverified. The software-rendered emulator recorded frame misses, so use a physical-device trace before making UI performance or optimization decisions.

After force-stopping the release following the scan series, the app reopened and restored the same last completed scan ID plus the two normalized offers priced at 800 and 900. The active engine state initialized to idle. The APK captures the code in the short build workspace used for this test. Parallel observability work in the shared tree was outside the scope of this artifact.

### Android M0 acceptance

| Check                                                                                     | Result                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go AAR and signed release APK contain valid ARM64 and x86_64 Go libraries                 | Pass                                                                                                                                                                                                                                                 |
| x86_64 release starts, initializes Go 0.1.0 and runs fixtures with zero retailer requests | Pass                                                                                                                                                                                                                                                 |
| Live progress, cancellation and another scan after cancellation                           | Pass. The release displayed cancellation at 1/3 and retained the last completed result. Progress also passed the development device test.                                                                                                            |
| Normalized offers and durable SQLite restore                                              | Pass. The release restored the identical completed scan and both offers after force-stop.                                                                                                                                                            |
| 20 sequential scans, distinct completions and persistence                                 | Pass. The release produced 20 distinct completed native IDs in one process. The separate development series matched one SQLite write event per completed ID.                                                                                         |
| Backgrounding and persistence without screen interaction                                  | Pass. A release scan completed while backgrounded and its new saved result appeared on foregrounding. The coordinator is mounted at the application root. A separate screen-unmount device test remains unrun because the fixture app has one route. |
| Termination during scan and restart recovery                                              | Pass. The release restarted with idle active state and preserved the previous completed scan. No interrupted result replaced it.                                                                                                                     |
| Stable controlled error                                                                   | Pass. `FIXTURE_ERROR` appeared in the release and the saved result was preserved.                                                                                                                                                                    |
| Responsive fixture controls                                                               | Pass for functional interaction on the emulator. Gfxinfo recorded frame misses and smoothness on a physical device remains unverified.                                                                                                               |
| Cancellation concurrency                                                                  | Pass. Host regression and race-detector checks exercised 20 start/cancel cycles per run.                                                                                                                                                             |
| Physical ARM64 launch and performance                                                     | Blocked. ADB detected no physical device. Follow the USB instructions above and install the release APK.                                                                                                                                             |
| Release SQLite write duration and end-to-end Expo bridge overhead                         | Partial. Development SQLite writes and a dedicated JNI probe provide baselines. Release write timing and full bridge overhead were unavailable.                                                                                                      |

Android M0 passes the x86_64 emulator gate. Keep the ARM64 physical-device gate open until the same release is exercised on an attached phone. No retailer requests or distribution took place during this verification.
