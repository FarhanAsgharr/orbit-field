# Building the Android APK locally

No Expo account, no EAS cloud build, no paid service. This produces an APK on
your own machine with Gradle.

`deployment/MOBILE.md` covers distribution and the EAS path. This document is
the local-only route, and the two do not conflict — `eas.json` is still there
and still works if you ever want it.

## What changed to make this possible

`apps/mobile/android/` is now a real, committed native project rather than
something `eas build` generates in the cloud. Three things were configured on
top of what `expo prebuild` produces:

- **Release signing** reads from Gradle properties, so no keystore or password
  is ever committed. `android/app/build.gradle`.
- **A debug-key fallback**, so `assembleRelease` works on a fresh clone with no
  keystore at all. It warns loudly, because a debug-signed APK cannot be
  distributed through a store and cannot be upgraded by a real build later.
- **A build-time URL guard.** `expo prebuild`'s output would happily bake in
  `localhost`; `app.config.ts` now refuses to package a release pointing at
  localhost, at `10.0.2.2`, at a `REPLACE-ME` placeholder, or at plain `http://`
  (Android blocks cleartext traffic from API 28, so an http backend fails every
  request on a release build with no useful error).

## Prerequisites

Neither is installed on this machine yet — both are free.

**JDK 17.** Newer JDKs are not supported by the React Native Gradle plugin.

```sh
brew install --cask temurin@17
/usr/libexec/java_home -V          # confirm 17 is listed
```

**Android SDK.** Either install Android Studio (easiest — it fetches the SDK,
platform 35 and build-tools for you), or command-line tools only:

```sh
brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.1.12297006"
```

Then, in `~/.zshrc`:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
```

## Building

The API URL is frozen into the artefact at build time, so it must be set. There
is no runtime override — an installed APK talks to one server for its whole
life.

```sh
cd apps/mobile

export EXPO_PUBLIC_API_URL="https://<your-api>.vercel.app/api/v1"

npm run android:apk        # → android/app/build/outputs/apk/release/app-release.apk
```

`android:bundle` produces an `.aab` for Play Store submission instead.

First build downloads Gradle and the dependency graph and takes 10–20 minutes.
Later builds are a few minutes.

## Signing it properly

Generate the keystore once. Losing it is unrecoverable: Android identifies an
app by its signature, so a lost key means existing installs can never be
upgraded, only uninstalled and reinstalled.

```sh
keytool -genkeypair -v -storetype PKCS12 \
  -keystore ~/keys/orbit-field-upload.keystore \
  -alias orbit-field -keyalg RSA -keysize 2048 -validity 10000
```

Put the values in `~/.gradle/gradle.properties` — outside the repository, so
they cannot be committed by accident:

```properties
ORBIT_UPLOAD_STORE_FILE=/Users/you/keys/orbit-field-upload.keystore
ORBIT_UPLOAD_STORE_PASSWORD=...
ORBIT_UPLOAD_KEY_ALIAS=orbit-field
ORBIT_UPLOAD_KEY_PASSWORD=...
```

The next `npm run android:apk` picks them up and the debug-key warning stops.

Verify what you produced:

```sh
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

## Installing

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Or copy the APK to the device and open it, with "install from unknown sources"
enabled for the file manager.

## If you re-run `expo prebuild`

`android/` is committed and hand-edited. `expo prebuild --clean` deletes and
regenerates it, which discards the release signing config. If you need to
regenerate (after adding a native module, say), re-apply the `signingConfigs`
and `buildTypes.release` blocks from `android/app/build.gradle` afterwards, or
run plain `expo prebuild` without `--clean`, which merges rather than replaces.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `Unable to locate a Java Runtime` | JDK 17 not installed, or `JAVA_HOME` unset |
| `SDK location not found` | `ANDROID_HOME` unset, or no `android/local.properties` |
| `EXPO_PUBLIC_API_URL is still the placeholder` | The guard working as intended — set the real URL |
| `A release build requires https` | Same guard; Android blocks cleartext on release |
| Sign-in fails on device, works in simulator | APK was built against a localhost URL, or the API's `CORS_ORIGINS` does not list the app's origin |
| `Duplicate class` after adding a package | `npm run android:clean`, then rebuild |
