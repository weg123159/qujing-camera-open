# 本次实际构建工具链

本轮使用 SDK 原生命令行工具编译，未使用 Android Gradle 插件。所有下载仅发生在开发构建环境，均不进入 APK 的运行流程。

| 组件 | 固定版本/文件 | 来源 | SHA256 |
|---|---|---|---|
| Android 平台 | API 35，revision 2，`platform-35_r02.zip` | `https://dl.google.com/android/repository/platform-35_r02.zip` | `0988cacad01b38a18a47bac14a0695f246bc76c1b06c0eeb8eb0dc825ab0c8e0` |
| Android Build Tools | 35.0.0，`build-tools_r35_linux.zip` | `https://dl.google.com/android/repository/build-tools_r35_linux.zip` | `bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88` |
| Eclipse Temurin JDK | `javac 17.0.20.1`，Linux x64 HotSpot | `https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz` | `3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e` |

Android ZIP 同时核对 Google 官方 `repository2-3.xml` 的 SHA1；JDK 核对 Adoptium 官方 API 返回的 SHA256。表中 SHA256 对实际下载字节重新计算。下载压缩包和工具链不入库，Windows 开发者需要下载相应 Windows 工具，而不是使用这些 Linux 可执行文件。

实际编译链：`aapt2 compile/link` → `javac --release 8` → `d8 --release --min-api 26` → 写入 DEX → `zipalign` → `apksigner sign/verify`。源清单和打包后的权限均检查没有 INTERNET。签名密钥位于仓库外的私有目录；本文件不包含密钥、密码或可恢复密钥的材料。
