# Qujing Camera · Offline Android APK

**Language / 语言:** [简体中文](README.md) · **English**

Package ID: `cn.qujing.camera`. Current source version: `0.6.0`. Minimum Android: API 26 (Android 8.0). Target API: 35.

The Android host uses the system **WebView** to run the same HTML, CSS and ES module interface as the web app, with native camera permission, system photo picking and file saving. It is not a native CameraX shooting engine. The required WebView, WebAssembly and camera features depend on the actual Android device.

The UI offers **中文 / English** selection in Settings. When the system itself uses English, the Android launcher label has an English resource; other locales retain the default Chinese name.

## Offline boundaries

- Pages, JavaScript, WASM, model weights, pose templates and example images are bundled under APK `assets/www/`. No first-launch model download is required.
- The Android manifest requests **CAMERA only**, not INTERNET, microphone, location or storage permissions. The app itself cannot make network requests; other device applications are unaffected.
- The WebView loads `https://appassets.androidplatform.net/www/` from a strict local asset interceptor. That host is an Android virtual origin, not an external service contacted over the internet.
- Import and save use Android system file pickers. A picker may offer cloud-backed providers; choose local device destinations for offline operation.
- Android System WebView is provided by the device and is **not** bundled with the APK. Verify camera, zoom, exposure, thermal behavior and file saving on actual hardware.

## Build prerequisites

Install JDK 17, Android SDK Platform 35, Build Tools 35.0.0 and Python 3.9+.

Run the regression suite and refresh the verified offline manifest before packing:

```sh
npm test
node scripts/build-offline-manifest.mjs

python3 scripts/android-build.py \
  --sdk /path/to/android-sdk \
  --jdk /path/to/jdk-17 \
  --keystore /outside-repository/release.p12 \
  --password-file /outside-repository/password.txt \
  --output /outside-repository/qujing-camera-0.6.0-release.apk
```

On Windows, use `python` and Windows paths. Build tools include `aapt2`, `javac`, `d8`, `zipalign` and `apksigner`. The script verifies packaging, manifest permissions, non-debuggable status, signatures and asset hashes. It creates an output SHA256 record and build report **outside Git**.

Signing credentials must stay outside the repository. Public APK certificates can reveal their subject names and fingerprints; never put personal email, address or sensitive identity information into published signing certificate fields. Reusing the same package name **and signing certificate** is necessary for normal in-place upgrades. Do not delete your private signing key without understanding the upgrade implications.

## Native bridge

The Java bridge is exposed only to the app's verified local HTTPS origin as `window.QujingNative`, not to arbitrary websites. It reports the platform and bundled-offline status and offers JPEG saving via the system picker. Save results are correlated by request ID; cancelling or failure leaves the preview available. Backgrounding stops live camera processing and discards stale requests.

For implementation and official SDK links see [Android toolchain](TOOLCHAIN.md). For camera operations and language selection see the [English user guide](../docs/V6-USER-GUIDE.en.md).

**Verification limit:** Source and automated tests do not replace a physical Android-device acceptance test, including first offline launch, permission prompts, rear/front camera behavior, zoom, EV controls and airplane-mode saving.
