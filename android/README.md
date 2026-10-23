# 取景相机 Android 离线安装包

包名 `cn.qujing.camera`，版本 `0.6.0`，最低 Android 8.0 / API 26，目标 API 35。应用使用系统 Android WebView 执行现有相机界面，加入相机权限、系统图片选择器和系统文件保存流程；不是原生 CameraX 拍摄引擎。设备需要可用且足够新的系统 WebView，ES modules、WebAssembly、getUserMedia 等能力取决于该组件。

## 离线边界

- `dist/` 的页面、JS、WASM、模型、姿势、图片完整装入 APK 的 `assets/www/`，首次安装也不需要下载模型。
- Android manifest **仅声明 CAMERA**；不声明 INTERNET、麦克风、位置或存储权限。WebView 和 Service Worker 均阻断网络请求。
- 页面使用 Android 预留的 `https://appassets.androidplatform.net/www/` 安全来源，由严格白名单的本地资源拦截器提供数据；不会访问该域名的网络服务器。资源读取限制在 `/www/`，禁止路径穿越，正确返回 `.mjs` / `.wasm` 类型，不启用 `file://` 跨域权限。外部链接保持关闭。
- 图片导入和 JPEG 保存使用系统文件选择器。系统选择器可能展示其他应用提供的云端位置，用户应选择设备本地目录；本应用本身没有联网权限，不能替用户关闭整台手机网络，也不能控制其他应用的网络行为。
- Android 包使用设备自带 WebView，不把浏览器内核打包进 APK。实际手机相机、镜头倍率能力、耗电和发热需要真机验证。

## 构建

构建脚本仅使用官方 JDK / Android SDK 命令行工具，没有运行时下载、Gradle 插件解析或外部 SDK。准备 JDK 17、Android `platforms;android-35`、`build-tools;35.0.0`、Python 3.9+；先运行仓库的离线清单生成脚本，然后：

```sh
python3 scripts/android-build.py \
  --sdk /path/to/android-sdk \
  --jdk /path/to/jdk-17 \
  --keystore /private/qujing-release.p12 \
  --password-file /private/password.txt \
  --output /path/to/qujing-camera-0.6.0-release.apk
```

Windows 同一脚本使用 `python`，参数换成 Windows 路径即可，SDK 的工具扩展名会自动处理。签名密钥和密码必须放在仓库之外；构建会拒绝仓库内密钥。证书主体信息可从正式 APK 中公开读取，因此不要在发布证书中填写个人姓名、邮箱或住址。已有安装包沿用同一证书才能正常升级；不要误删或擅自更换仓库外的真实签名密钥。

脚本检查 manifest 权限、非调试标志、签名、ZIP 对齐、DEX、所有打包资源的 SHA256；在 APK 旁生成 `.build-report.json` 和 `.sha256`。临时中间文件放 `android/build/`，不进入 Git。`--allow-missing-offline-manifest` 仅供中间开发编译，不能用于最终交付。

## 页面桥接契约

只在上述 Android 本地 HTTPS 来源识别 `window.QujingNative`，不能把普通网页上可伪造的同名对象当成离线保障。

- `getInfo()` 返回 JSON：`platform: android`、`version: 0.6.0`、`bundledOffline: true`、`networkPermission: false`、`savePhoto: true`。
- `savePhoto(dataUrl, requestId)` 仅接受 JPEG data URL；先校验尺寸和字节上限，再打开系统保存器。单次保存尚未完成时拒绝重复请求。完成后分发 `qujing-native-save`，其 `detail` 包括 `requestId`、`status`（`saved/cancelled/error`）、`message`。仅在流写入并关闭后报告保存成功，关闭选择器不报告成功。
- Android 返回键先发送可取消的 `qujing-native-back`；页面处理面板/编辑退出后 `preventDefault()`。页面不处理时，宿主关闭顶部对话框或退出 Activity。
- Activity 暂停时发送 `qujing-native-pause`；页面应停止相机并取消倒数。系统相机权限弹窗本身可能暂停 Activity，因此该请求待处理时保留 WebView，避免取消首次开启；Activity 真正进入 `onStop` 时仍强制通知页面并拒绝未完成权限请求。Android 页面使用此明确事件处理后台停止，不把权限弹窗引起的 `document.hidden` 当成用户取消。销毁时释放权限请求、文件选择回调和 WebView。

## 平台资料

- [Android 本地内容加载](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [WebSettings 网络与文件访问](https://developer.android.com/reference/android/webkit/WebSettings)
- [WebView 权限请求官方示例](https://github.com/googlesamples/android-PermissionRequest)
- [AAPT2 命令行构建](https://developer.android.com/tools/aapt2)
- [APK 签名工具](https://developer.android.com/tools/apksigner)

这些资料支撑宿主实现与构建方式，不代替真机验收。
