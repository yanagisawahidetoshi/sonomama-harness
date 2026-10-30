#!/usr/bin/env bash
# Builds the Android Development Build (debug APK with expo-dev-client) for the maestro CI job when the APK cache missed.
set -euo pipefail
cd apps/mobile
npx expo prebuild --platform android --no-install
# Install the NDK React Native pins with sdkmanager first; Gradle's own download of it is not checked and has left a broken archive on CI.
ndk=$(sed -n 's/^ndkVersion = "\(.*\)"$/\1/p' "$(node -p "require('path').join(require.resolve('react-native/package.json'), '..', 'gradle', 'libs.versions.toml')")")
{ yes || true; } | "${ANDROID_HOME:?}/cmdline-tools/latest/bin/sdkmanager" --install "ndk;${ndk:?ndkVersion not found}" > /dev/null
cd android && ./gradlew assembleDebug --no-daemon
