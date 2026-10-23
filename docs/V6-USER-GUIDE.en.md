# Qujing Camera V6 / 0.6.0 · User Guide

**Language / 语言:** [简体中文](V6-USER-GUIDE.md) · **English**

## Installation and offline mode

This repository provides source code, **not a signed APK download**. Build the Android package yourself with the official Android toolchain and a signing key stored outside the repository. An Android APK built from this source packages the web pages, detection models, pose library and example images together and only requests the camera permission; it does not request `INTERNET`.

No app-level internet permission does not mean that Wi-Fi or mobile data is disabled system-wide. For full-device offline operation, use airplane mode or disable network access yourself. When choosing import/save destinations, select local device storage if you do not want cloud services involved.

For the browser edition, initially load the page over HTTPS, then choose **Settings → Offline use → Download complete offline assets**. Offline readiness is reported only after all required resources pass integrity checks. Browser caches can still be cleared later.

## Taking a photo

1. Open the camera and allow the required permission. The top bar controls aspect ratio and a three-second timer; settings are at the top right.
2. Select **Guide** at the bottom. Choose a shot size, composition and optional pose. Extreme-wide and wide shots show the subject smaller, while medium and close shots intentionally crop the body.
3. Tap **Position**. Tap or drag the stick-figure reference into place, then select **Finish placing**. The anchor represents an approximate foot point for full-body shots or face center for closer shots.
4. Use the zoom presets, continuous zoom slider or pinch gesture. The interface distinguishes device-controlled zoom from digital crop. Recheck placement after changing zoom or aspect ratio.
5. Tap the light advice chip for pixel-based brightness, highlight and shadow information. Exposure compensation is only applied when the device confirms support; ISO and shutter values are advisory.
6. Select **Style** to choose Natural, Clear, Soft Warm, Film or Black & White. Adjust brightness, contrast, saturation and warmth. These edits appear in the exported photo but do not alter sensor ISO, shutter or white balance.
7. Take a photo and inspect the preview. Select the system save location on Android or the available save/share option in your browser. Cancelled saves retain the preview. Explicitly save photos you want to keep before closing the app.

You can switch the interface between **中文 / English** in **Settings → 语言 / Language**. Your choice is stored on the device, and translations do not require an online service.

## Background position planning

Open the current guidance details and select **Compare scene positions** under **Framing consistency**, or use the settings shortcut. Mark a region where it is actually safe for a person to stand, ideally with the person temporarily out of frame. The app suggests up to three candidate image positions inside this user-selected area.

The calculation considers the pose outline (head, hands and feet), chosen shot size, composition target, crop and visible pixel edges and brightness. Outstretched arms need more space than a sideways pose. If a detected person obscures the intended head-and-shoulder background, the app cannot infer the hidden pixels.

**This is a 2D visual reference, not a safety system.** It does not identify cliffs, roads, walkable ground, three-dimensional distance or depth. Confirm actual conditions yourself and keep the camera still after applying a position.

## Technology and limitations

Face location uses BlazeFace with a TinyFaceDetector fallback. Person location uses COCO-SSD Lite MobileNet V2 and only the generic `person` class. The bottom center of a person detection box approximates the feet; there is no anatomical joint estimate, person identification or posture-completion score.

Light suggestions are derived from pixels after camera processing, not a calibrated illuminance sensor. Manual parameter advice is illustrative and should not be mistaken for actual device controls. Color looks cannot recover clipped highlights or replace HDR, night photography or denoising.

Android runs the interface through the system WebView and uses a narrow native bridge for permission and file saving. Actual camera zoom, exposure compensation, frame rate, thermal behavior, offline first launch and saving in airplane mode require tests on a real target device.

## Safety, licenses and source

The two bundled sample photos were generated through ChatGPT web and are only demonstration assets; they are not endorsements or references to a verified real individual. Third-party dependencies keep their own licenses. See [Third-party notices](../THIRD_PARTY_NOTICES.en.md) and [Release compliance](RELEASE-COMPLIANCE.en.md).

For installation or changes to signing keys, see [Android build instructions](../android/README.en.md). Never commit signing materials or disclose personal data in public signing certificate fields.
