# 取景 · Qujing Composition Camera

**Language / 语言:** [简体中文](README.md) · **English**

Qujing is a mobile composition-guidance camera with live preview, shot-size guides, eight composition layouts, fourteen articulated stick-figure pose references, adjustable photo looks, light advice, and face/person location detection performed on the device. This repository contains a browser app and an offline Android APK host. It is **not** a CameraX-powered native camera, does not support iOS APK installation, and does not claim manufacturer HDR, night processing, optical-lens selection, or AI pose recognition.

The user interface supports **中文 / English** via **Settings → 语言 / Language**, with your choice saved locally. There is no translation service or account requirement, and language switching does not modify camera frames, recognition models, or saved photo pixels.

## Features

| Feature | Behavior and limitations |
| --- | --- |
| Live framing | Real camera preview, front/rear camera selection when available, full-screen mobile controls |
| Shot sizes | Seven references: extreme wide, wide, full, medium full, medium, close, and detail |
| Composition | Rule of thirds, centered, negative space, golden ratio, symmetry, diagonal, leading lines, framing |
| Poses | Fourteen original stick-figure templates with body, hand and gaze cues; no actual joint tracking |
| Position guidance | Drag or tap the reference position; live face/person boxes are located on-device |
| Zoom | Uses the camera track's reported zoom capability where available, otherwise clearly labeled digital crop; offline photo crop is separate |
| Light analysis | Pixel-based brightness, highlights and shadows; relative EV adjustment only when the device confirms support |
| Photo looks | Natural, Clear, Soft Warm, Film, Black & White; adjustable brightness, contrast, saturation and warmth |
| Background position planning | Up to three candidate 2D positions within a region **you** select; cannot assess walkability, distance, depth or safety |
| Export | JPEG derived from the currently visible crop, without grids, detection boxes or stick figures |

The pixel-based light analysis is not a calibrated exposure meter. Digital zoom does not add image detail. A bounding box is not a body-pose estimate or identity recognition.

## Run the web app

The static application lives under `dist/`, with plain HTML, CSS and ES modules. It has no frontend framework build step:

```sh
python scripts/dev-server.py
```

Open <http://localhost:8000/>. The loopback-only development server serves \`.mjs\` and \`.wasm\` with correct MIME types. Access from another phone generally requires **HTTPS** for camera permissions. Web browsers must initially fetch the page and models; use **Settings → Offline use → Download complete offline assets** to verify and cache the required resources. Browser storage can still be cleared by the browser or user. The app does not pretend that an installed web shortcut guarantees offline availability.

The Android APK variant bundles the page, JS, WASM, weights and sample images under `assets/www/`, and the Android manifest only requests `CAMERA` (no `INTERNET` permission). It uses the device's system WebView and native system file pickers. The APK itself is **not included in this source repository**, and device behavior still requires real-device verification.

## Use the camera

1. Open the camera, allow permission if prompted, and choose aspect ratio or a three-second timer.
2. Select **Guide**, then shot size, composition and an optional pose. Pose suggestions are filtered by scene; they do not verify that the actual person performs that pose.
3. Tap **Position** and drag the stick-figure reference. For full-body shots the anchor approximates the feet; for tighter shots use the face center. Tap **Finish placing**.
4. Select a zoom preset or open the continuous slider. Pinch to zoom outside placement mode. If the device cannot expose zoom control, the interface explicitly uses digital crop.
5. Open the light card for pixel-based advice. In **Style**, adjust a look before capture. Device EV controls only appear when supported and confirmed.
6. Take the photo, review it and explicitly save or share it. Cancelling the system picker retains the preview; unsaved photos are not a persistent photo library.

For more detail see [User guide (English)](docs/V6-USER-GUIDE.en.md) or [使用说明（中文）](docs/V6-USER-GUIDE.md).

## Models and bundled open-source software

| Purpose | Component | Version |
| --- | --- | --- |
| Primary face location | MediaPipe Tasks Vision + BlazeFace short-range float16 | 0.10.14 |
| Face fallback | face-api.js TinyFaceDetector (bundled TF.js core) | 0.22.2 |
| Person detection | TensorFlow.js + COCO-SSD `lite_mobilenet_v2` | 4.22.0 + 2.2.3 |
| Pose and composition | Project-authored geometric templates and pixel heuristics | Local code |

Models run locally when requested. The offline Android package includes required models; the web edition needs offline preparation before it can reliably reopen without a connection. The app has no photo-upload or identity database service.

All upstream licenses and model sources are documented in [Third-party notices](THIRD_PARTY_NOTICES.en.md). The original licenses are bundled under `dist/assets/vendor/`. The BlazeFace short-range model card published by Google specifies Apache License 2.0; each other dependency remains under its own upstream terms.

## Zoom, light and continuity safeguards

Device zoom and exposure requests share a serialized, debounced queue; the UI uses values actually read back from the camera instead of displaying attempted values as successes. Late detector results are rejected after source, camera, mode or zoom changes. Stable live alignment requires multiple distinct valid observations and expires when tracking is lost. Static photos and preselected demo points are reference-only, not proof of sustained tracking.

Seven shot sizes and eight composition rules are independent. Manual position references do not alter image pixels. The frozen-background planner operates only on the currently visible 2D crop and the region the user explicitly selects; it does not infer actual safety or geometric distance in meters.

## Android build

Requires Python 3.9+, JDK 17, Android SDK Platform 35 and Build Tools 35.0.0. The build script uses the official Android command-line toolchain without fetching a Gradle runtime.

```sh
npm test
node scripts/build-offline-manifest.mjs

python3 scripts/android-build.py \
  --sdk /path/to/android-sdk \
  --jdk /path/to/jdk-17 \
  --keystore /outside-the-repository/release.p12 \
  --password-file /outside-the-repository/password.txt \
  --output /outside-the-repository/qujing-camera-release.apk
```

Your signing key and password must remain **outside** Git. The script checks packaged resources, permissions, debug status and signature validation. An Android signing certificate's public identity is inspectable from an APK, so do not put personal contact information into public certificate fields. Changing the signing certificate may prevent direct upgrades of previous installations. See [Android README](android/README.en.md) and [Toolchain](android/TOOLCHAIN.md).

## Tests and verification limits

Run `npm test` to execute the module regression suite. Its tests cover camera-state handling, zoom geometry, pose/layout math, pixel-based advice, offline resource integrity, the native save bridge, and license inventory. On the Windows preparation environment, **291 tests passed; one symlink-specific test was skipped** because symbolic-link creation was not permitted.

Passing unit tests or browser simulation does not mean that real Android devices have been verified for model startup, camera zoom/EV behavior, performance, thermal limits, accessibility or flight-mode saving. Hardware acceptance must be performed separately.

## License, images and brand

The project-authored source code and documentation are licensed under [MIT](LICENSE). Embedded dependencies keep their respective licenses; the MIT license does not relicense them. The two bundled demo pictures were provided as outputs generated in the ChatGPT web interface, with source and byte hashes recorded in [Image provenance](docs/ASSET-PROVENANCE.en.md). This does not grant exclusive rights against similar outputs or override third-party rights.

Refer to [Release compliance](docs/RELEASE-COMPLIANCE.en.md) for limits of the trademark check, signing-certificate privacy and public-distribution review. The name **Qujing / 取景** has **not** been conclusively cleared by a formal trademark database search.

This public repository was created from a cleaned source snapshot and does **not** include historical screenshots, signing keys, previously signed APKs or the private development repository's Git history.
