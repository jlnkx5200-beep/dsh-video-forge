# 视觉质量标准与渲染规范（硬性）

> 适用范围：`plugins/dsh-video-forge` 的全部渲染侧代码（`remotion/src/**`）、后端编排（`src/**`）、
> ComfyUI 工作流（`workflows/**`）与自定义节点（`comfyui-nodes/**`）。
> 本文是**门禁文档**：与 `docs/visual-quality-standard.md` 冲突的实现一律视为 bug，不是"风格选择"。
> 执行脚本：`node scripts/check-quality.mjs`（静态门禁）+ `Visual QA Loop`（动态门禁，必须人工看图）。

---

## 0. 一句话红线

**宁可拦住不产片，也不许把"伪深度 / 亮度抠像 / 480P 糊屏 / 人为噪点"当成正式成片交付。**

---

## 1. 上游资产（ComfyUI / Seedream / MiniMax）

### 1.1 深度：必须是真模型

| 允许 | 禁止 |
| --- | --- |
| `DshDepthModel`（Depth Anything V2 Small/Base，本地权重，transformers 后端） | `DshDepthEstimate` 的亮度+Sobel 伪深度（**仅 draft**） |
| `DshDepthRefine`（导向滤波对齐原图边缘 + 2%/98% 分位拉伸） | 未经平滑的高频噪点深度图直接做顶点位移 |
| 工作流 `dsh-depth-v2.api.json` | 工作流 `dsh-depth.api.json` |

* 权重放在 `ComfyUI/models/depth_anything_v2/<模型目录>/`（`config.json` + `model.safetensors`），
  或由 `DSH_DEPTH_MODEL_DIR` 指定。
* **找不到权重必须抛错**，不允许静默回退伪深度。

### 1.2 抠像：必须是真语义模型

| 允许 | 禁止 |
| --- | --- |
| `LoadBackgroundRemovalModel(birefnet.safetensors)` + `RemoveBackground` | `DshAlphaMatte` 的纯亮度阈值（**仅 draft**） |
| 工作流 `dsh-matte-v2.api.json` | 工作流 `dsh-matte.api.json` |

### 1.3 2.5D 边缘撕裂：必须走「剥离 + 修复 + 保边平滑」三件套

1. **前景剥离 + 背景板修复**：`DshLayerSplit(mode=bg)` —— push-pull 金字塔用周围像素填洞，
   不使用生成式 inpaint（无幻觉、确定性）。工作流 `dsh-plate.api.json`。
2. **深度保边平滑**：`DshDepthRefine`（guided filter）。
3. **位移幅度**：`spatial.displacement ≤ 1.2`；`uDepthScale` 上限 2.4，默认 0.9。

> 有 `plate` 时，**远景必须用 plate，主体静帧只能出现在主体层**；没有 plate 又叠同图两层 =
> 边缘撕裂 + 画面发灰，视为违规。

### 1.4 视频档位

* `production`：视频分辨率 ≥ **768P**，优先 1.25K/2K；`480P` 只允许在 `draft`。
* 视频层**满幅贴合主体平面**（尺寸 = 主体画面 ×1.04，同深度），与静帧层共用一次相机运动；
  **不许**做"画中画硬边矩形"（廉价感最大来源，见 `docs/visual-qa-log.md` R3）。
* 视频满幅时默认 `blend: normal`；`lumaKey` 满幅会把亮部烧白，只能配合掩码局部使用。
* 纯文本 T2V 必须显式给 `ratio`（官方不接受 `adaptive`，会 400）。
* H3 出片 `moov` 在尾部，落盘后必须 `ffmpeg -c copy -movflags +faststart` 重封装，否则逐帧 seek 失败。

---

## 2. 渲染侧（Three.js / Shader / Remotion）

### 2.1 色彩管线（曾经的真实 bug，别再犯）

* 场景渲进 `HalfFloat` RT（线性空间）→ 后处理 `COMPOSITE_FRAG` 内做 **ACES → 线性转 sRGB 编码**。
* `WebGLRenderer` 侧：`toneMapping = NoToneMapping`、`outputColorSpace = SRGBColorSpace`
  （three 不会给自写 `ShaderMaterial` 自动加 `colorspace_fragment`，漏了就是整片发灰）。
* 颜色贴图：`colorSpace = SRGBColorSpace` + `generateMipmaps` + `anisotropy = 8`；
  深度/遮罩贴图：`NoColorSpace` + 纯线性、不生成 mipmap、`anisotropy = 1`。
* RT `samples = 4`（MSAA）；`ThreeCanvas` 的 `antialias` 只作用于直渲路径。

### 2.2 图层尺寸：一律由视锥推导，禁止硬编码

```ts
frameAt(distance, fovDeg, aspect) // height = 2 * d * tan(fov/2)
```

* 主体层：`frameAt(subjectDepth, fov, 16/9) * 1.02`
* 背景板：`* 1.25`（多留余量，位移时不露边）
* 视频层：高度 = `subjectFrame.height * videoCoverage`

> 历史教训：把 2K 静帧硬编码成 `30×16.9 @ z=-8`，而 z=-8 的视高只有 ≈6.1，等于把原图放大 3 倍 ——
> 这是"画面糊"的第一大原因。

### 2.3 后处理默认值

* `grain` 默认 **0**（人为颗粒 = 画质红线）；需要胶片感由 `film` pass 显式给，且 ≤ 0.012。
* `vignette` ≤ 0.2；`contrast` ≤ 1.1；`saturation` ≤ 1.15；`exposure` 0.8 ~ 1.0（ACES 亮部）。
* **顺序铁律**：线性曝光 → ACES → 线性转 sRGB → 再在显示域做 lift/gain/contrast/saturation/暗角/颗粒。
  在线性域先做 `pow(1/2.2)` 或先做对比度 = 整体抬亮一档（实测把 9/255 抬到 149/255）。
* **禁止暴力邻域梯度轮廓增强**：`edgeBoost` 生效强度已被内部 ×0.35 限制，预设默认 ≤ 0.06。
* 混合模式统一拼写 `lumaKey`（`luakay` 仅作为历史别名被解析层接受）。

### 2.4 确定性（Remotion）

* 禁止 `Math.random()` / `Date.now()` / `state.clock.elapsedTime`；一律 `mulberry32(seed)` 与 `localFrame/fps`。
* 资源加载只能走 `assetLoader`（渲染期同步 `delayRender`）；**不许写 `useEffect` 里挂门闩**。
* 同一帧渲两次必须 `pngdiff maxDiff = 0`。

---

## 3. 预设（`remotion/src/presets/`）

任何新预设必须**显式**实现六大维度（`presets/style.ts` 的 `StyleSpec`），缺一不可：

| 维度 | 必填字段 |
| --- | --- |
| `lighting` | exposure / contrast / saturation / lift / gain / bloom / bloomThreshold / bloomRadius / vignette |
| `optics` | fov / dof / focus / videoCoverage / feather |
| `spatial` | parallax / displacement / plateDepth / subjectDepth / atmosphere / atmosphereOpacity / horizon |
| `surface` | particle / count / color / size / spread / amplitude / edgeBoost / tint / tintAmount |
| `motion` | arc / drift / transition |
| `promptModifiers` | anchors（≥ 3 条）/ negative（必须含"涂抹感/噪点/水印/低质纹理"类） |

且必须同时在 `src/bridge/style-prompts.ts` 里登记**同名 id** 的上游提示词锚点，
使"上游生图审美"与"下游渲染观感"闭环。id 不一致视为违规。

---

## 4. 强制视觉自检闭环（Visual QA Loop）

修改以下任一类文件后，**`tsc` 通过 + `pngdiff=0` 都只是及格线，不是验收**：

* `remotion/src/engine/**`、`remotion/src/presets/**`、任何 `.glsl`/Shader 字符串
* `workflows/**`、`comfyui-nodes/**`
* `src/bridge/**`（影响 plan / prompt / 策略）

必须执行：

```bash
# 1) 关键帧（至少 0/30/60/90/120 五个时间点）
node scripts/still.mjs public/forge/<planId>/plan.json 0   out/qa-f000.png
node scripts/still.mjs public/forge/<planId>/plan.json 30  out/qa-f030.png
node scripts/still.mjs public/forge/<planId>/plan.json 60  out/qa-f060.png
node scripts/still.mjs public/forge/<planId>/plan.json 90  out/qa-f090.png
node scripts/still.mjs public/forge/<planId>/plan.json 120 out/qa-f120.png

# 2) 动态成片（默认保留音轨；TEMP/TMP 由脚本指向 ~/.dsh/video-forge/tmp）
node scripts/render.mjs public/forge/<planId>/plan.json out/qa.mp4
#    要显式静音才加 --muted（占位片省一次混流）

# 3) 跨帧连贯性（t=30 vs t=90）与确定性
node scripts/pngdiff.mjs out/qa-f030.png out/qa-f090.png
```

然后**必须亲自看图**（多模态读图），按下表逐项打分，任何一项 ✗ 都要回去改代码再跑一遍：

| # | 检查项 | 通过标准 |
| --- | --- | --- |
| 1 | 通透锐利 | 无可见人为颗粒/压缩糊块/整体发灰；2K 原图细节（树/纹理）可辨 |
| 2 | 边缘干净 | 主体边缘无白边、黑边、蜂窝噪点、深度撕裂锯齿 |
| 3 | 空间分离 | 前/中/背景有真实视差与空气透视，不是一张图平移 |
| 4 | 图层关系 | 视频层与静帧层不互相遮挡，视频不整屏糊住主体 |
| 5 | 跨帧连贯 | 运镜/粒子/动效平滑，有电影节奏；t=30 与 t=90 内容变化合理 |

**验收记录**必须落盘：`docs/visual-qa-log.md`（每轮写时间、planId、帧、结论、缺陷与修复）。
