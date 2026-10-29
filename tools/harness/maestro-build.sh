#!/usr/bin/env bash
# Builds the Android Development Build (debug APK with expo-dev-client) for the maestro CI job when the APK cache missed.
set -euo pipefail
cd apps/mobile
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleDebug --no-daemon
