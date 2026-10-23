# V6 Composition Engine · English Architecture Overview

**Language / 语言:** [完整中文技术说明](V6-ENGINE.md) · **English overview**

This overview describes the principal interfaces and safety boundaries of the Qujing composition camera. It complements the [English README](../README.en.md) and [user guide](V6-USER-GUIDE.en.md). For the full list of numerical thresholds and function-level implementation details, consult the Chinese engineering specification and the test modules.

## Geometry and observations

The application distinguishes the original camera/photo source coordinates from the currently visible crop and the on-screen viewfinder. Zoom, aspect ratio, pan and front-camera mirroring must use the **same crop mapping** for display, subject detection and output. A digital enlargement never introduces additional source pixels.

The seven shot sizes determine the reference body region (full body, knees, waist, chest or face) independently from the eight composition presets. `dist/guide.mjs`, `dist/shots.mjs` and `dist/zoom-geometry.mjs` handle framing geometry; `dist/composition-engine.mjs` combines shot size, the current subject box, reference pose outline, zoom state and frozen background evidence.

Manual points and authored stick figures must never be represented as measured human joints. The bottom of a detected person bounding box is an approximation of the foot point, not a physical ankle location. Cropped portraits cannot be evaluated with full-body head-to-toe checks.

## On-device detection

Face detection uses MediaPipe BlazeFace, with a face-api.js TinyFaceDetector CPU fallback. Generic person detection uses TensorFlow.js COCO-SSD, analyzing only the `person` class. Neither path performs identity recognition or posture-completion scoring.

The camera schedules asynchronous inference without accumulating concurrent tasks. A source/mode/camera/zoom change invalidates old observation IDs and rejects late inference callbacks. `guidance-stability.mjs` only declares stable live alignment after distinct recent valid observations; stale, empty or low-confidence results clear that state.

## Poses and background position planning

Fourteen original articulated stick-figure poses are stored in `dist/poses.mjs`. Each includes a name, body/hand/gaze advice, scene tags and optional conditions. A pose can be drawn at different shot sizes and mirrored independently from a front-facing camera.

`dist/planner.mjs` compares head-and-shoulder background clutter and geometric distance from the selected composition target. It only searches within a user-selected region and may propose up to three positions. The algorithm cannot determine real-world safety, ground type, depth, distance or an occluded background. A changed source, zoom, pose or placement context invalidates a previous plan.

## Light analysis and looks

`dist/scene-analysis.mjs` samples brightness distributions in current unstyled viewfinder pixels. The module can describe relative highlights, shadows and differences between a detected subject box and nearby visible background. It does not measure lux, light color temperature, device ISO or an objectively correct exposure value.

A camera EV control is enabled only after the current video track reports a usable range and mode. Requests share a serialized queue with zoom controls and are considered successful only after actual device readback.

The five `photo-style.mjs` presets use adjustable brightness, contrast, saturation and warmth. Capture and preview follow the same processing sequence. Color processing cannot restore clipped data or substitute for multi-frame HDR, night mode or denoising.

## Offline packaging and app localization

`scripts/build-offline-manifest.mjs` enumerates every distributable file under `dist/` and records SHA-256 and byte length. The Service Worker uses these values to establish a fully prepared web cache. The Android host bundles the same assets into the APK and requests CAMERA only, without INTERNET.

The `dist/i18n.mjs` presentation layer provides **中文 / English** switching with local dictionaries and no translation network calls. It translates static text, accessibility labels and supported runtime messages while preserving the Chinese source strings in the computation modules. This presentation transformation does not modify pose geometry, model weights, image data or exported JPEG pixels.

## Verification

Run `npm test` and `node scripts/build-offline-manifest.mjs` after changing a distributable asset. The Node suite checks geometric consistency, source lifecycle, offline checks and localization messages. A passing automated suite does not replace real Android-device verification for camera zoom, EV behavior, framerate, saving, offline first launch or accessibility.
