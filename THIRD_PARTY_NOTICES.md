# 第三方组件许可与来源

本项目自有代码与文档使用仓库根目录 MIT 许可证；各第三方库、模型权重以及其他非自有资源仍以各自的原始许可证为准。重新打包发行时必须保留对应许可证及适用的版权通知。

| 组件 | 版本与路径 | 权利信息 |
| --- | --- | --- |
| MediaPipe Tasks Vision | 0.10.14；`dist/assets/vendor/vision_bundle.mjs` 及 `wasm/` | Apache-2.0；`dist/assets/vendor/LICENSE` |
| BlazeFace short-range | float16 v1；`dist/assets/vendor/blaze_face_short_range.tflite` | **Google 官方模型卡明确标注 Apache-2.0**；随包保留 MediaPipe 许可证 |
| face-api.js | 0.22.2；`dist/assets/vendor/face-api/` | MIT；该目录 `LICENSE` |
| TinyFaceDetector 权重 | face-api.js v0.22.2 官方发布权重 | 随 face-api.js 官方版本分发；应继续保留原项目许可证 |
| TensorFlow.js（兼容检测器） | 1.7.0 | Apache-2.0；`dist/assets/vendor/face-api/TENSORFLOW-LICENSE` |
| TensorFlow.js | 4.22.0；`dist/assets/vendor/person/tf.min.js` | Apache-2.0；`dist/assets/vendor/person/LICENSE` |
| COCO-SSD | 2.2.3；`dist/assets/vendor/person/coco-ssd.min.js` | Apache-2.0；`dist/assets/vendor/person/LICENSE` |
| SSDLite MobileNet V2 图与权重 | `dist/assets/vendor/person/model/` | 依上游 TensorFlow.js 模型分发说明，许可证与哈希记录位于同目录 |

## 第一手授权依据

- BlazeFace short-range **Google 官方模型卡**：https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf ，第 1 页明确写明“Licensed under Apache License, Version 2.0”。
- BlazeFace 官方模型下载：https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite
- Google MediaPipe 官方人脸检测说明：https://developers.google.com/edge/mediapipe/solutions/vision/face_detector
- MediaPipe 原始代码及许可证：https://github.com/google-ai-edge/mediapipe
- face-api.js：https://github.com/justadudewhohacks/face-api.js
- TensorFlow.js：https://github.com/tensorflow/tfjs
- COCO-SSD：https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd

上述模型卡对应短距 BlazeFace 型号；应用所带权重取自文档中该型号的官方 float16/1 路径。官方许可证可允许商用和再分发，但须履行保留许可证、版权及适用通知的义务。不能以模型的开源许可证代替商标和用户个人信息使用许可。

## 应用中的自制图片

`dist/assets/demo.jpg` 与 `dist/assets/portrait.jpg` 由项目作者通过网页版 ChatGPT 生成并提供，仅用于本地图像与构图演示，不宣称照片中的人物存在真实代言关系。依据 OpenAI 自 2026-01-01 生效的个人服务使用条款，用户在适用法律允许范围内拥有输出：https://openai.com/policies/terms-of-use/ 。输出不一定唯一、不得侵害第三方权利，生成输出不当然享有各司法管辖区相同的独创性保护。素材 SHA-256 见 `docs/ASSET-PROVENANCE.md`。

设置中的「第三方许可与来源」提供本机内置的许可证与来源文本查看入口。
