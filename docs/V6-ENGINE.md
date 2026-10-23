# V6 构图、光线与倍率计算引擎

日期：2026-10-21。本文依据当前仓库代码说明模块行为与接入约定，面向维护者和验收人员。

**状态：算法模块与 UI 已接入，模块回归测试可以在当前源码中运行；Android 真机表现与设备离线验收仍为 NOT_RUN。** 模块测试不代表手机镜头切换、帧率、设备参数响应或离线首启已通过。相关断言参见 [构图测试](../tests/composition-engine.test.mjs)、[相机测试](../tests/camera.test.mjs) 和 [离线测试](../tests/offline.test.mjs)。

## 1. 这一版实际计算什么

V6 将景别目标、画幅、参考动作轮廓、主体观测、倍率和背景像素纳入同一坐标约定。它提供可解释的几何检查、背景候选排序、画面明暗建议，以及独立的照片风格处理。

| 模块 | 实际依据 | 输出 |
|---|---|---|
| `dist/composition-engine.mjs` | 已绘制的姿势关节、景别、目标位置、可信检测框、当前倍率、背景像素 | 几何检查、警告、待确认事项、有限制的倍率估算 |
| `dist/planner.mjs` | 用户圈选的脚点区域、实际姿势包络、头肩后方像素 | 区域内候选、原因、轮廓和采样诊断 |
| `dist/scene-analysis.mjs` | 未套风格的可见画面、可选主体框、用户选择的拍摄意图 | 显示亮度统计、相对曝光补偿建议、建议稳定状态 |
| `dist/photo-style.mjs` | 用户选定的风格及调整值 | 有序滤镜表达式、RGBA 像素处理、可选风格建议 |
| `dist/zoom-motion.mjs` | 当前数字倍率、目标倍率、经过时间 | 连续的数字裁剪值或请求值反馈 |
| `dist/camera.mjs` | 设备能力、实际设置读回、约束调用结果 | 经确认的设备倍率和曝光补偿状态 |

这些新增计算模块不包含神经网络权重。主体检测结果来自上游检测器；参考火柴人的关节来自人工编写的姿势模板。**“读取参考动作的真实几何”指读取模板实际画出的关节和轮廓，不代表识别或重建了镜头前真人的关节。**

当前没有场景语义分割、深度估计、地面可站立判断、人体姿势匹配或学习式审美评分。不会从单目像素推算人物应移动多少米，也不会根据边缘密度给背景贴上道路、草地或建筑标签。

## 2. 坐标、来源与证据约定

### 2.1 所有判断使用可见取景坐标

目标点、观测点、检测框、脚点区域和背景像素必须对应**同一张已经裁剪、已经按预览方向镜像的画面**：

- 左上角为 `(0, 0)`，右下角为 `(1, 1)`，`x` 向右、`y` 向下。
- `aspect` 为显示画面的宽高比，即显示宽度除以高度，不是未经裁剪的传感器宽高比。
- 框使用 `{x, y, width, height}`；脚点区域为 `{x, y, w, h}`。
- 检测框映射时保留超出画面的部分，让引擎能发现头脚已经裁出；不能先截到 `[0,1]` 后再声称完整。
- `poseMirrored` / `mirrored` 控制参考动作左右翻转；它与前置相机整幅画面的镜像是两个概念，调用者须避免重复翻转。

`zoom-geometry.mjs` 的 `getZoomCrop()` 和 `pointToCropView()` 提供以居中 `cover` 裁剪为基础的数字变焦与点映射。它们的变换应同时用于预览、参考覆盖层、背景冻结和导出。真实设备倍率已经作用于视频轨道时，不能再无条件对同一倍率做第二次数字裁剪。

### 2.2 版本值不等于自动验证

`sourceKey` 标识当前几何来源；`zoomRevision` 标识倍率版本。换相机、换照片、画幅或镜像改变，以及裁剪改变时，调用层应产生新来源/版本并取消旧异步结果。

`assessFrameCoordination()` 只有在背景的 `sourceKey` 和 `zoomRevision` 都与本次输入严格相等、且倍率不处于 `pending` 时，才使用背景像素。它无法通过一段裸 RGBA 数组反向核实来源；调用者错误地复用版本号仍会造成错误证据。

主体点和框也必须在调用前经过上游来源检查。协调接口没有独立的“检测框来源版本”字段，不能只换顶层 `sourceKey` 后继续传旧框。

`analyzeScene()` 只携带 `sourceKey`，没有独立的 `zoomRevision` 参数。接入时应使用包含来源、裁剪/镜像和倍率版本的有效键；硬件曝光改变后也要清理旧明暗建议。实时稳定器需要真实观测的独立 `observationId`，重复绘制同一帧不能补足证据数量。

## 3. 参考姿势与景别几何

### 3.1 姿势数据来自公共渲染结果

```js
getPoseGeometry(poseId, { mirrored = false } = {})
```

该函数调用 `poses.mjs` 的 `getPose()`、`renderPoseSvg()`，解析显式 `data-joint` / `data-part` 元数据并缓存结果：

- 要求存在 13 个主要关节及头部、两个肩关节。
- 只读取头部圆、关节圆，以及明确标记的 `M/L` 骨架线段。
- 包络考虑关节半径和骨架笔画余量，排除视线箭头、脸部装饰、道具等非身体元素。
- 未知姿势、缺失关节或不支持的骨架路径返回 `null`，不猜测轮廓。

输出含 `points`、`joints`、`bounds`、`head`、`shoulders`、`headShoulders`、`poseId`、`mirrored` 和 `method`。这是当前作者模板的二维几何；不包含真人的体型、衣物、发型或道具尺寸。

### 3.2 人物高度与实际宽度使用同一缩放

```js
computePoseFootprint({ poseId, x, y, height, aspect = .75, mirrored = false })
```

`x/y` 是全身参考脚点，`height` 是人物参考高度占画面高度的比例。共享 SVG 为 `200 × 500`，参考头顶和脚点为 `y=10/480`，身体参考跨度为 `470`。整张 SVG 的位置为：

```text
template.left   = x - (100 / 470) × height / aspect
template.top    = y - (480 / 470) × height
template.width  = (200 / 470) × height / aspect
template.height = (500 / 470) × height
```

随后把选中姿势的实际包络投影到画面，返回 `{x, y, width, height, template, headShoulders, poseId, mirrored, source}`。`source` 为 `authored-reference`。

这里的 `template` 是整张 SVG 的摆放尺寸；外层 `x/y/width/height` 是身体实际占用范围，两者不能混用。渲染时应按 `template` 摆放，不能把整个 SVG 拉伸塞进身体包络。

例如在相同 `height=.7`、`aspect=.75` 下，当前 `easy-angle` 包络宽度约为画面的 `0.2210`，`open-view` 约为 `0.3328`。张臂动作确实需要更宽空间；镜像也会交换不对称动作的左右留白需求。数值仅描述当前模板。

### 3.3 景别决定锚点和允许的裁切

| 景别 ID | 名称 | 观测/锚点 | 处理方式 |
|---|---|---|---|
| `extreme_wide` | 大远景 | 人体 / 脚点 | 完整保留头脚，默认参考高度 10% |
| `wide` | 远景 | 人体 / 脚点 | 完整保留头脚，默认参考高度 20% |
| `full` | 全景 | 人体 / 脚点 | 完整动作，默认参考高度 78% |
| `medium_full` | 中全景 | 脸框 / 脸中心 | 膝部附近的裁切参考 |
| `medium` | 中景 | 脸框 / 脸中心 | 腰部附近的裁切参考 |
| `close` | 近景 | 脸框 / 脸中心 | 胸部以上的裁切参考 |
| `detail` | 特写 | 脸框 / 脸中心 | 面部边缘取舍由用户确认 |

脸框大小不能证明真人的腰、膝或手恰好位于参考裁切线，也不能从脸框倒推出准确全身高度。近景缺少脚部属于预期，不能触发“请把脚放回画面”的全身规则。

协调引擎对完整人物景别采用三个产品参考高度区间：大远景 `4–16%`、远景 `14–42%`、全景 `55–90%`。超出时提示比例与景别存在差异，保留用户的自定义选择。这些区间是产品约定和可调启发式，不是摄影标准、景深公式或实测距离。

```js
constrainPoseTarget({
  shot = 'wide', target, aspect = .75, poseId,
  mirrored = false, margin = .02
})
// -> { target, fits, changed, bounds, footprint, reason }
```

完整人物景别按实际姿势包络和默认 `2%` 画面留白限制锚点；中近景只限制锚点，不把有意裁掉的下半身移回画面。放不下时返回 `fits:false`，不会悄悄降低请求的人物高度。未知姿势在此位置约束函数中使用整个 SVG 的保守边界；协调检查仍会把姿势证据标为缺失。

接入时取返回值的 `.target`，并处理 `fits`。不能把整个返回对象当作目标点，也不能忽略“不适配”状态后显示成功。

## 4. 统一协调接口及状态

```js
assessFrameCoordination({
  shot = 'wide', target, aspect = .75,
  poseId, poseMirrored = false,
  point = null, box = null, observedKind,
  observationOrigin = 'detected',
  zoom = { mode, value, min, max, pending },
  sourceKey = '', zoomRevision = 0,
  background = null // 或 { pixels, width, height, sourceKey, zoomRevision }
})
```

`observedKind` 为 `person` 或 `face`；手动/示例输入须明确传 `observationOrigin:'manual'/'example'`，不能依赖默认的 `detected`。缺省 `target` 从当前景别产生。

常规输出为：

```js
{
  checks, warnings, primary, status, summary,
  geometry, zoomAdvice, backgroundMetrics,
  sourceKey, zoomRevision, artisticScore: null
}
```

无效上下文等提前返回路径可能不包含 `backgroundMetrics`，UI 应按缺失处理。每项检查格式为 `{code, state, title, detail, priority, evidence}`，其中 `state` 为 `pass / warn / unknown`。

| 状态 | 何时出现 | 可表达的含义 |
|---|---|---|
| `needs-adjustment` | 至少一项 `warn` | 有具体的几何或像素问题需要调整 |
| `reference-only` | 无警告，但至少一项 `unknown` | 部分依据不足，继续作为参考 |
| `geometry-consistent` | 所有当前检查均通过 | 本次几何/采样关系接近参考 |

`geometry-consistent` 不表示时序稳定、真人姿势匹配、照片好看或地面安全，也不自动授权快门。`primary` 优先返回优先级最高的警告，没有警告时返回首项待确认。全身参考越界、实测人物裁出等问题优先于普通位置、比例或背景提示。

主要证据规则：

- 完整人物参考按实际头、手、脚包络检查；协调警戒边界为画面 `1.5%–98.5%`，与摆放约束的 `2%` 留白形成余量。
- 选择了与景别标签不匹配的动作会提示；需要杯子或墙面的动作保留人工确认，不推断道具存在。
- 仅 `observationOrigin==='detected'` 的有效框参与实测大小和倍率建议。手动点、示例点只可提供位置参考。
- `visible:false`、错误的观测类型、倍率 `pending` 会撤销相关主体依据；旧框不能恢复“已对齐”。
- 真人人体框裁出画面时先提示完整取景，不使用它给出可信身高匹配。
- 没有当前背景、背景版本不符、透明像素不足时，背景保持未知；近景背景站位规划也保持人工确认。

### 4.1 倍率建议的边界

`zoomAdvice` 仅在真实检测框有效、景别评估确认大小可测、框完整位于画面、倍率已稳定且输入范围有效时生成。裁切或靠边造成大小未知时不建议倍率；设备范围与保留主体的范围无交集时返回 null。基本目标为：

```text
desired = currentZoom × targetHeight / observedBoxHeight
```

所有景别均按以画面中心缩放后的实测主体框四边距离限制可用倍率，尽量保留 `2%` 边缘余量，并与设备 `min/max` 求交。输出含 `desired`、`feasible`、`limitedByFrame`、`limitedByRange`、目标/观测高度和 `estimated:true`。

这是假设当前画面按中心比例改变的建议；实际设备可能换镜头、改裁剪或改变检测框，应用后必须重新检测。数码裁剪保留的像素会减少；它不改变相机位置和透视，不保证远处小人物更易识别。输出没有米数、焦距或“光学变焦”认证。

## 5. 用户选区内的背景站位规划

```js
planStandingPositions({
  pixels, width, height, region, target, bodyHeight,
  limit = 3, aspect,
  poseId, poseMirrored = false,
  sourceKey = '', zoomRevision = 0, zoomPending = false,
  subjectBox = null // 与冻结画面同源的可信检测框
})
// -> { candidates, diagnostics }
```

`pixels` 为当前选定背景的 RGBA 数据，`region` 必须由用户明确圈选为**脚点可以考虑的位置区域**。引擎只在该区域与姿势可完整放入画面的区域交集中搜索；不会自动扩大选区来强行产生结果。用户选区本身也不等于系统已经确认可站立。

传 `poseId` 时使用实际姿势的左右、头顶和脚底范围。未传姿势的旧调用保留 `0.42 × height / aspect` 的通用矩形以兼容旧 API；提供了未知姿势 ID 时直接返回 `invalid_pose`，不会悄悄降级后声称按该动作计算。

### 5.1 背景比较如何计算

共享函数 `analyzeTargetBackground({pixels,width,height,target,bodyHeight,aspect,poseId,poseMirrored})` 将当前动作的头肩区域投影到候选位置，并执行：

1. 在头肩区域至多 `17 × 17` 个采样点上比较显示亮度均值、方差和邻近像素差。
2. 已知姿势时，额外采样头部圆周上的 20 个点和两肩之间的 13 个点，记录轮廓附近的边缘强度。
3. 只使用 alpha 至少为 240 的有效像素；区域采样有效覆盖不足 90% 时返回 `null`。轮廓采样也检查有效覆盖。
4. 以局部边缘、亮度标准差、头肩轮廓边缘合成内部背景干扰指标。已知姿势时三项权重为 `0.35 / 0.40 / 0.25`。

亮度代理为 `(0.2126R + 0.7152G + 0.0722B) / 255`，针对已经处理过的显示像素；它不是传感器线性光强。单像素边缘和采样栅格会受分辨率、纹理周期、曝光及主体遮挡影响。权重与阈值目前是可解释的工程启发式，尚未通过真实手机/照片数据集标定为审美概率。

候选排序采用 `0.68 × 背景适配 + 0.32 × 距构图目标适配`，同时剔除过于接近的重复候选。旧字段 `score` 为兼容保留的相对排序数值；不得在 UI 将它叫作照片美学分、识别置信度或安全概率。优先展示 `reason` 与诊断，而不是给用户虚构审美百分分。

### 5.2 主体遮挡与可见像素边界

共用 `assessTargetBackgroundOcclusion()` 检查同源可信检测框与目标头肩 ROI 的几何重叠。覆盖达到 25% 时，协调模块返回 `background_occluded / unknown`、`backgroundMetrics:null`，在读取像素前停止；规划器跳过该候选。如果所有位置都不可用，则提示人物暂时移开、重新取背景。25% 是保守几何阈值，不是分割置信度。

规划诊断包含 `rejectedForOcclusion`、`subjectOcclusionAvailable` 和 `occlusionThreshold`。没有可信框时只描述“当前头肩区域的可见像素”，指标注明 `visiblePixelsOnly:true` 和 `segmentation:false`，不能断言这些像素全部属于背景。参考与真人重合、尚未检测到真人或其他物体遮挡时，仍存在无法观察隐藏背景的限制。

### 5.3 输出与应用候选

候选包含：

```js
{
  x, y, height, score, reason,
  footprint, template,
  metrics: { /* 背景采样指标、compositionFit、distance */ },
  provenance: { sourceKey, zoomRevision, poseId, poseMirrored }
}
```

`diagnostics` 含可行边界、实际身体宽度、来源版本、方法、采样数量、拒绝数量及返回代码。`zoom_pending`、`invalid_image`、`invalid_region`、`invalid_target`、`invalid_height`、`invalid_aspect`、`invalid_pose`、`no_space`、`no_background_samples` 等状态会返回空候选。

有效采样明确标注：

```js
semanticLabels: false
depthMeasured: false
groundSafetyAssessed: false
```

`provenance` 记录调用者提供的版本，并不自行比较当前 app 状态。打开规划器时应冻结来源、裁剪、镜像、画幅、景别、人物高度、姿势 ID 和姿势翻转；应用候选前再次核对。任何影响像素或几何的值改变后，旧候选须失效或重新计算。

## 6. 光线分析与建议稳定器

```js
analyzeScene({
  pixels, width, height,
  subjectBox = null, sourceKey = null, intent = 'portrait'
})
```

输入必须是**尚未应用照片风格**的当前可见画面，否则滤镜会污染测光依据。`intent` 只接受 `portrait / still / motion`，来自用户选择；模块没有运动检测器。

输出为 `{ok,sourceKey,code,intent,condition,conditions,metrics,recommendation,limitations,method}`。无效结果为 `ok:false`、`metrics:null`、`recommendation.ev:null`，不产生可应用参数。

分析按最长边约 192 个采样间隔控制计算量，产生 256 桶直方图、均值、5/50/95 分位、暗部占比、亮部占比、单通道近溢出占比和局部边缘统计。透明或有效样本过少时失效。

有有效主体框时，人物框上部的粗略区域用于主体亮度代理；其他框使用中心区域。背景取框外像素。框中衣服和混入的背景会影响结果，它不是皮肤测光或精确前景分割。主体/背景样本不足时相应数值为 `null`，但仍可提供全画面的亮暗分析。

| 代码 | 当前判定依据概要 | 正确解释 |
|---|---|---|
| `backlit` | 主体均值低于 0.42、背景高于 0.55，背景减主体大于 0.22 | 主体区域与背景反差大；未识别光源方向 |
| `highlights` | 显示亮度至少 0.94 的像素占比达到 6% | 较多亮部接近纯白 |
| `low_light` | 均值低于 0.23，或亮度不超过 0.12 的像素多于 52% | 当前处理后的画面偏暗；未测量环境照度 |
| `high_contrast` | 95/5 分位跨度大于 0.72，且两端分别高于 0.80、低于 0.20 | 显示画面明暗跨度较大 |
| `balanced` | 上述条件均未触发 | 未发现这些像素问题，不等于曝光绝对准确 |

条件按上述顺序选择主建议，可同时保留多个标签。EV 建议为相对当前曝光的 `delta`，当前规则可能给出 `-0.7/-0.3/0/+0.3`，带 `advisoryOnly:true`。逆光代理同时伴有亮部接近溢出时不会一律加曝光。

无法根据当前预览可靠算出精确 ISO、快门或光源色温，参数提示因此保留“自动优先”。用户选择运动人物时的 `1/250 秒` 仅作为手动尝试起点，不是实际测量结论，也不会由模块自动写入设备。

### 6.1 实时建议何时可采用

```js
createSceneStabilizer({
  minSamples = 2, minDurationMs = 350, maxAgeMs = 1800
})
// -> { reset(sourceKey), update(analysis, {now,observationId}), get(now) }
```

稳定器要求不同观测 ID、递增时间，以及相同主条件、EV 建议和拍摄意图持续至少指定时间。默认至少 2 个观测跨越 350 ms 才可 `stable:true`；超过 1800 ms 未更新会过期。换条件会立即撤销稳定状态，重复帧不累计。

返回 `{analysis,stable,expired,sourceKey,samples,reason}`。换源/裁剪/倍率等变化必须先 `reset(newKey)`；不同来源的晚到结果会被拒绝。静态照片可直接分析，实时相机应使用稳定器。稳定表示同类建议连续出现，仍不保证照度、曝光数值或语义判断准确。

若用户选择应用 EV，应由 `CameraController.setExposureCompensation()` 写入真实设备。代码仅在曝光补偿范围、实际读回值及自动测光模式均可确认时开放控制；设备请求排队并读回确认。`delta` 是建议增量，不能直接当作绝对 EV 目标。拒绝、静默忽略或回读失效不能显示“已应用”。

## 7. 风格与拍摄参数分离

`photo-style.mjs` 提供五个原创预设：`natural` 原色、`clear` 清透、`warm` 柔暖、`film` 胶片、`mono` 黑白。可调项为明暗 `-40…40`、对比 `-40…40`、饱和 `-100…100`、暖调 `0…60`。暖调是颜色滤镜强度，不是开尔文色温，也不改变设备白平衡。

| API | 行为 |
|---|---|
| `createStyleSettings(id)` | 返回预设设置副本 |
| `normalizeStyleSettings(settings)` | 限制调整范围并过滤非数值输入 |
| `isStyleIdentity(settings)` | 判断是否为原色且所有调整为零 |
| `styleFilter(settings)` | 返回固定顺序的 CSS 滤镜，原色零调整返回 `none` |
| `applyStylePixels(pixels,settings,{inPlace:false})` | 对直通 alpha 的 RGBA 字节执行实际像素处理，默认不修改输入 |
| `recommendStyle(scene,intent)` | 仅返回建议 ID 和原因，不改变用户设置 |

顺序固定为 `brightness → contrast → saturate → sepia → grayscale（黑白预设）`。RGBA 回退执行对应运算并保留 alpha；原色零调整保持原像素。预览与 Canvas 导出应使用同一设置快照和顺序；缺少 Canvas 滤镜支持时可使用像素回退。

这些是显示域的画面效果，不是传感器曝光、降噪、多帧 HDR、虚化或厂商色彩管线。提亮无法增加原始细节，调暗已纯白区域无法恢复丢失高光。跨浏览器/真机预览与保存的视觉一致性仍需验收，不因存在同一函数而宣称所有实现逐字节一致。

## 8. 连续倍率与设备真实倍率

```js
createZoomMotion({
  value = 1, min = 1, max = 6,
  timeConstantMs = 60, epsilon = .001
})
// -> { getState(), setTarget(value), step(timestampMs), reset(value) }
```

数字倍率在对数空间按经过时间渐近目标：

```text
log(next) = log(current)
          + (log(target) - log(current)) × (1 - exp(-elapsed / timeConstant))
```

这使 `1→2` 与 `2→4` 的同比例变化使用相同曲线，动画不依赖指针事件数量或固定帧率。新目标替换旧目标，不排队反弹；达到相对容差后精确落到目标。`reset()` 清理旧动作，`timeConstantMs:0` 可直接跳转。

状态为 `{value,target,active,settled,min,max}`，`step()` 另含 `changed`。默认范围仅是构造参数，不能据此宣称设备具有 `6×` 镜头。

数字裁剪可直接使用该 `value`；设备倍率的实际值必须使用 `CameraController` 的设置回读。相机请求与 EV 共用串行队列，合并过时请求并保留已确认的其他约束。`pending` 和 `requested` 表示请求状态，不能被动画的 `settled` 替代；`applyConstraints()` Promise 成功也不等于设备采用了请求值。

接入时需在数字动画或设备约束进行中撤销旧构图/背景依据；稳定后再恢复当前裁剪的真实观测。手感、镜头切换连续性和设备响应仍属于真机验收内容。

## 9. 有效、参考与失效条件速查

| 场景 | 处理 |
|---|---|
| 当前可信主体框、有效模板、对应版本背景，所有几何条件通过 | 可输出本次 `geometry-consistent`，仍不代表真人姿势或时序稳定 |
| 只有手动点/示例点 | 位置参考；大小和倍率估算不可作为实测结果 |
| 全身框或动作轮廓裁出 | 明确警告，先保留完整身体 |
| 中近景有意裁下半身 | 按景别保留裁切；脸框不能验证身体裁切线 |
| 缺少背景、主体框、姿势或道具证据 | 对相关项返回 `unknown`，不补造成功 |
| 来源/倍率版本变化或倍率正在调整 | 丢弃旧像素和旧观测；规划候选不可直接沿用 |
| 人物大小正确但动作更宽 | 用具体姿势重新计算，不按固定宽高比放行 |
| 照片偏暗 | 可给显示亮度建议；不报真实照度或精确 ISO |
| 用户选了风格 | 继续用未套风格画面分析；推荐不覆盖手动设置 |
| 设备不支持可靠 EV/倍率回读 | 保留建议/数字裁剪可用路径，不冒充设备设置成功 |
| 脚点区域看似平坦或背景很简洁 | 仍需用户现场判断；不输出地面安全结论 |

## 10. 已验证范围与设备待验收

2026-10-21 主验收逐模块执行 15 个模块、281 项，全部通过。其中协调引擎 27 项、planner 18 项、光线 12 项、风格 8 项、工作台 7 项、倍率动效 11 项、相机控制 59 项。测试以合成几何、像素和受控设备状态为主，不代表真实场景识别准确率。

当前源码提供可重复运行的模块断言，覆盖连续倍率、相机能力读取、光线统计、风格处理、背景候选和状态失效行为；测试不替代真实设备画面核验。公开仓库不包含历史 UI 截图，完整验收请以独立构建后的现场复测为准。

另针对发现的两处 app 风险，以当前实际函数在临时 VM 中复现：视频从 640×480 变为 1280×960 后，中心点仍映射为 (0.5,0.5)，来源键采用新裁剪；设备步长把 1.1× 请求吸附为当前 1× 后，事务正常结束，随后真实 2× 请求会清除重新规划的旧站位。

**仍为 NOT_RUN：** Android 真机首次离线启动、真实 WebView 对倍率及 EV 的支持与响应、前后及物理多镜头切换、自拍实拍、系统保存取消/失败的真机链路、长时间帧率/发热/耗电和现场人物移动。最终 APK 的签名、权限和资源核验记录独立于这些设备测试。

不能将本说明解读为已达到小米原生相机流畅度、自动理解背景并安排安全站位，或计算出了唯一最佳曝光。当前有真实计算引擎，其结果受输入证据、设备能力与规则覆盖限制。
