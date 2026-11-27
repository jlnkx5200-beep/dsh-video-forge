# 视觉自检记录（Visual QA Loop）

> 规范见 `docs/visual-quality-standard.md` 第 4 节。
> 每一轮都必须：出关键帧 → 出 mp4 → **亲自看图** → 按五项打分 → 记录缺陷与修复。
> 打分只写事实（看见了什么），不写"感觉不错"。

---

## 轮次 R1 —— 「画质升级」前的基线（问题清单）

时间：2026-11-17 20:00 前后 ｜ planId：`plan-mwkmijfp`（480P / H3-Lite）

缺陷（全部为真实观感，不是猜测）：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 整片发灰、像隔着一层雾 | `COMPOSITE_FRAG` 在**线性空间**先 `pow(1/2.2)` 再 ACES，等于整体抬亮一档；深谷 9/255 被抬到 149/255 |
| 2 | 画面糊 | 图层尺寸硬编码 `30×16.9 @ z=-8`，而该距离可视高度只有 ≈6.1，等于把原图放大 3 倍 |
| 3 | 同一张图铺两层 | `StageStack` 远景 + 主体都用同一张静帧，两层错位重影 |
| 4 | 半透明"面片"盖在画面上 | `PARALLAX_FRAG` 用深度当 alpha（`smoothstep(0,0.35,depth+0.25)`），近处越亮越透明 |
| 5 | 全屏白色雾带 | `Atmosphere` 加性平面 `depthTest:false` 铺满整幅 |
| 6 | 视频铺满全屏、糊成一片 | 视频平面尺寸 = 画面高度，480P 上采样到 1080p |
| 7 | 人为颗粒 | `grain` 默认 0.035，`film` pass 0.055 |

---

## 轮次 R2 —— 修复后：纯 2K 分层视差成片

时间：2026-11-17 21:00 ｜ planId：`plan-1mx1iq8` ｜ 5s / 30fps / 150 帧 / 1920×1080
上游：Seedream `5.0-flash` 2048×1152 → DA2-Small 真深度 → BiRefNet 真抠像（plate 未启用）
预设：`cinematic-realism` ｜ 机位：dolly-in `z 2.2 → -0.6`

关键帧：`out/film1-f000.png` `f030` `f090` `f120` ｜ 成片：`out/film1-parallax-2k.mp4`

| # | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 通透锐利 | ✅ | 岩壁纹理、单棵冷杉、雾层丝缕都可辨；无颗粒、无糊块 |
| 2 | 边缘干净 | ✅ | 山脊/树线无白边、无锯齿、无深度撕裂 |
| 3 | 空间分离 | ✅ | 近景岩壁 → 中景雾海 → 远景层叠山脊，景深与空气透视成立 |
| 4 | 图层关系 | ✅（无视频） | 单层整帧渲染，无半透明面片、无露边 |
| 5 | 跨帧连贯 | ✅ | t=30 vs t=90 `maxDiff 196 / changed 91.5%`（推镜造成整体位移，属预期）；运镜平滑、无跳切 |

缺陷与修复（本轮内）：见 R1 表 1–3、5、7 项；另修 `uDepthScale` 上限、`grade`/`glow` 覆盖默认值、图层尺寸改为按**最远机位**推导。

---

## 轮次 R3 —— 视频融合成片

时间：2026-11-17 21:10 ｜ planId：`plan-1mx1iq8`（同 plan，带 H3 视频）｜ 5s / 150 帧
上游视频：MiniMax H3 `1344×768` / 5s（真机调用，`463…`）

关键帧：`out/f2-f000.png` `f030` `f090` `f120` ｜ 成片：`out/film2-video-fusion.mp4`

| # | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 通透锐利 | ⚠️ 可接受 | 与 R2 相比略软：H3 原生 768P 上采样到 1080p，属上游分辨率限制，非渲染缺陷 |
| 2 | 边缘干净 | ✅ | 满幅贴合后无硬边矩形、无黑边 |
| 3 | 空间分离 | ✅ | 视频随相机推镜整体位移，雾层在画面内流动，空间感成立 |
| 4 | 图层关系 | ✅ | 视频满幅（1.04×）铺在主体平面，静帧退到背景，不再互相遮挡 |
| 5 | 跨帧连贯 | ✅ | t=30 vs t=90 `maxDiff 187 / changed 84.1%`，雾在动、机位在推 |

本轮修掉的坑：

* 视频平面做成"画中画"硬边矩形 —— 廉价感最大来源 → 改为满幅 + 与主体平面同深度；
* `feather` 羽化在 headless Chromium 下不稳定（同一参数下整片消失）→ 固定 0，融合靠满幅与调色；
* `lumaKey` 满幅会把亮部烧白 → 默认 `normal`；
* H3 mp4 的 `moov` 在尾部 → 显式 `-movflags +faststart` 重封装后才能逐帧 seek。

---

## 轮次 R4 —— 确定性复测

时间：2026-11-17 21:15

```
node scripts/pngdiff.mjs <同一帧渲两次的 png>   → maxDiff 0 / changed 0.00%
```

静帧场景、视频场景均 `maxDiff 0`。（历史 bug：`InstancedSpatialField` 用 `state.clock.elapsedTime`，同帧两次差 0.5% 像素。）

---

## 当前仍未达标的项（诚实记录）

1. **视频清晰度受上游限制**：H3 `768P` 是当前性价比档，1080p 输出必然略软；要更锐需要 2K 档（成本 ×3~4）或后续加超分 pass。
2. **背景板（plate）在本轮未启用**：BiRefNet 对"无明确主体"的风景会给整幅前景，剥离后背景板出现大片空洞（`comfy-5-plate_00001_.png` 有明显黑块），因此 `enablePlate` 默认关闭，只有主体清晰的产品/人物镜头才开。
3. **粒子层在 `cinematic-realism` 里很淡**：当前 dust 320 个、透明度低，1080p 下几乎不可见；如需"空气里的浮尘"要调 `surface.particle` 强度。

---

## 轮次 R5 —— MAGI-2 / 客户端大改后的渲染回归（mock）

时间：2026-11-27 11:30 ｜ planId：`qa-magi2-client-mwyfa4qi` ｜ 4 镜 / 390 帧 / 13s @30fps
预设 `cinematic-realism` ｜ `mock:true` ｜ `enablePlate:true` ｜ 剧本：雨中的独石（4 镜 dolly-in → handheld → orbit → dolly-out）

> 为什么是 mock：本轮改动集中在 Host 侧（`src/core/providers/magi2.ts`、`src/bridge/compiler.ts`、
> `src/core/runtime.ts`、`src/client/**`）与渲染侧的 `isVideoStrategy()` 分流，**没有任何着色器/调色/图层尺寸改动**。
> 目的是证明「改造没有破坏既有渲染链路」，而不是重新评一次美术；真机素材（Seedream 5.0-flash / H3）
> 已在 R2/R3 评过，本轮按成本纪律不重复扣费。资产是占位图，故第 1 项只测"是否又被洗白"这一历史缺陷。

产出命令（可复现）：

```
node scripts/qa-mock.mjs                                  # 走真 compiler → scheduler → providers → RenderPlan
node scripts/still.mjs public/forge/qa-magi2-client-mwyfa4qi/plan.json 0  out/qa-magi2-f000.png
node scripts/still.mjs ... 30 / 60 / 90 / 120
node scripts/render.mjs public/forge/qa-magi2-client-mwyfa4qi/plan.json out/qa-magi2.mp4 --muted
```

| # | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 通透锐利 | ✅ 无回归 | 暗部像素仍在 14–30/255 区间（R1 的"9/255 被抬到 149/255"洗白缺陷没有复发）；渐变无 banding |
| 2 | 边缘干净 | ✅（占位资产） | 板层满幅铺满，1920×1080 全画面无硬边矩形、无黑边、无羽化露边 |
| 3 | 空间分离 | ⚠️ 无法评（占位） | depth/matte 由 mock 生成（`mock-asset-*`），视差按占位梯度位移；版式（层尺寸）正确，但"真实景深"要等真机素材才能评 |
| 4 | 图层关系 | ✅ | 4 镜的 still/plate/depth/matte 全部落到 `forge/qa-magi2-client-mwyfa4qi/`，`fillShotAsset` 映射正确，无相互遮挡/半透明面片 |
| 5 | 跨帧连贯 | ✅ | 同帧渲两次 `maxDiff 0 / changed 0.00%`；0→120 帧星点随推镜整体位移，运镜连续无跳切；成片 390/390 帧，4.3 MB |

本轮同时验证到并修掉的坑：

* **`enablePlate:true` + `seedream-static` 会编译出指向不存在节点的依赖**：`任务 s1:plate 依赖了不存在的 s1:matte`
  （plate 只在 `comfy-pipeline` 才会顺带生成 matte）→ 改为「开 plate 即隐含 matte 任务」，并在 `matteWorkflow` 缺失时给 warn；
* `compileStoryboard` 的 magi2 分支不会把 `magi2-direct` 误判成需要静帧（`needStill` 只看 `magi2-i2v`），
  纯文生视频不再白花一次出图钱；
* 渲染侧新增 `isVideoStrategy()`：`magi2-direct` / `magi2-i2v` 镜头与 `minimax-direct` 走同一条 video-first 通路
  （渲染侧只认"这一镜是不是视频驱动"，不认具体 Provider —— 保持 Host/Renderer 隔离铁律）。

---

## 轮次 R6 —— 真机素材美学评审（P0 补做）

时间：2026-11-27 12:19 ｜ planId：`plan-1mx1iq8`（R2 的真机产物，未新增扣费）｜ 1 镜 / 150 帧 / 5s @30fps / 1920×1080
预设 `cinematic-realism` ｜ 策略 `comfy-pipeline` ｜ 素材：Seedream 5.0-flash 静帧 + Depth Anything V2 + BiRefNet matte + plate + H3 视频

> 为什么补这一轮：R5 是「改造没破坏链路」的回归检查，占位资产下第 3 项（空间分离）根本无从评价，
> 所以严格说**美术质量从未被完整评过**。本轮直接用 R2 已落盘的真机 plan 重渲，零新增成本，
> 把五项补齐 —— 这也暴露了此前被"回归通过"掩盖的问题。

产出命令（可复现，不产生任何 Provider 调用）：

```
cd remotion
node scripts/still.mjs public/forge/plan-1mx1iq8/plan.json 0   out/r6-f000.png
node scripts/still.mjs public/forge/plan-1mx1iq8/plan.json 30  out/r6-f030.png
node scripts/still.mjs public/forge/plan-1mx1iq8/plan.json 60  out/r6-f060.png
node scripts/still.mjs public/forge/plan-1mx1iq8/plan.json 90  out/r6-f090.png
node scripts/still.mjs public/forge/plan-1mx1iq8/plan.json 120 out/r6-f120.png
```

| # | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 通透锐利 | ✅（有保留） | 前景右壁的岩石纹理、苔痕、受光面边缘都清晰可辨；暗部仍保有蓝灰色相（约 110/125/135），没有 R1 那种"抬灰变中性灰"的洗白。**保留**：中远景雾幕占画面 60% 以上，f120 时白雾逼近 255，锐度观感被大气稀释 |
| 2 | 边缘干净 | ✅ | 前景山脊与背景板交界处无硬边、无黑边、无羽化露边；右侧崖壁的树线没有被切出锯齿 |
| 3 | 空间分离 | ✅ | f000→f120 推镜过程中前景左山与右侧崖壁明显放大外扩，远山山脊几乎原地不动，位移差可肉眼判定；不是"整幅图一起缩放"的假视差 |
| 4 | 图层关系 | ✅ | 无重影、无半透明鬼影、无画面内重复山形；plate 的空洞在本镜没有出现（本镜主体明确，BiRefNet 抠得干净） |
| 5 | 跨帧连贯 | ✅ | 5 帧顺序推演连续，无跳变；同帧两渲 `maxDiff 0`（R4 已固化）。**观察**：0→120 帧整体亮度随雾涌入而抬升，属构图问题而非调色问题 |

本轮结论与遗留：

* 真机素材下五项全部成立，**"空间分离"这条终于有依据**（R5 只能标"无法评"）。
* 新发现两条可执行改进（已并入 `docs/04` 待改进处）：
  1. **推镜撞亮部**：`dolly-in` 把镜头推进雾幕，末帧曝光观感偏白、视觉重心丢失 —— 建议给 `camera` 加曝光关键帧，
     或在 `lighting.exposure` 上做随帧衰减（当前是常量）；
  2. **雾占比过高**：`spatial.atmosphereOpacity` 在该 preset 下偏强，长镜头后段会吃掉主体对比度，
     建议按镜头时长自动降权，而不是全片一个常量。
* 本轮不涉及任何着色器/调色代码改动，`check-frames` 的像素基线（`golden-baseline-v1`）与 R4 的确定性结论保持一致。

## 轮次 R7 —— 真机 15 秒水墨开篇（README 首屏）

时间：2026-11-27 14:24 ｜ planId：`plan-wmxu7h` ｜ 3 镜 / 450 帧 / 15s @30fps / 1920×1080
预设 `oriental-ink`（第 2 镜由视频策略强制走 `video-first`）｜ 策略 `seedream-static` / `minimax-2k-repaint` / `seedream-static`

素材与费用（全部真机，仅此一次）：

| 镜 | Provider 调用 | 计费 |
| --- | --- | --- |
| s1 《破墨入山》 | Seedream `5.0-flash` 1024×1024 静帧 + ComfyUI `dsh-depth-v2` 真深度图 | ≈0.30 元 + 本地 GPU 免费 |
| s2 《墨韵化鹤》 | Seedream 首帧 + MiniMax H3 **2K** 4s（2560×1440 出片，转 1920×1080@30 后喂渲染） | ≈0.30 元 + 3.20 元 |
| s3 《孤舟印落》 | Seedream `5.0-flash` 静帧 + ComfyUI `dsh-depth-v2` | ≈0.30 元 + 本地 GPU 免费 |

合计 ≈ **4.10 元**（预算上限 5 元）。真机调用前先跑 `mock: true` 全链路（6 任务 / 3.9s / 0 元）校验路由与 DAG。

回放命令（零成本，可重复）：

```
cd remotion
node scripts/render.mjs public/forge/plan-wmxu7h/plan.json out/hero-oriental-ink-15s.mp4 --crf=18 --concurrency=2
```

| # | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 通透锐利 | ✅ | f0 / f120 焦墨老松与山体皴法边缘清晰，留白处仍见生宣肌理；推镜末段（f120）受光面未越过 250，无 R6 那种"撞亮部洗白" |
| 2 | 边缘干净 | ✅ | 老松枝干与云岚交界无硬边、无黑边；丹顶鹤轮廓（f210）未出现抠像毛边；船与水面倒影过渡自然（f330/f440） |
| 3 | 空间分离 | ✅ | f0→f120 推镜中近景老松放大显著、远峰位移极小，肉眼可判定为真视差（真深度图，非亮度伪深度） |
| 4 | 图层关系 | ✅ | 无重影、无半透明鬼影；两处转场（f145 luma-wipe / f295）无撕裂、无黑边、无穿帮 |
| 5 | 跨帧连贯 | ✅ | 三镜同一墨色语言（宣纸米白 + 松烟焦墨 + 一点朱砂），色调过渡连续；末帧 f440 为静止感强的高级定格 |

本轮结论：

* 五项全部成立，**直接作为 README 首屏**：1080p 成片作为 Release v0.1.0 附件分发（不入库），首屏用 800px / 13fps 自动循环 WebP（1.83 MB）+ 1920×1080 封面帧（271 KB）。
* R6 遗留的两条改进在本轮以最小改动落地：`oriental-ink` 的 `atmosphereOpacity` 0.30 → 0.18、`exposure/contrast` 0.92/1.03；
  `video-first` 粒子 220×0.07 → 110×0.035（原尺寸在浅底画面上会结成可辨的灰球）。
* 本轮顺带修掉两个渲染器级缺陷（帧 135 / 帧 301 的 `TimeoutError`）：视频层改用镜头局部帧，seek 目标钳进片长。
  详见 CHANGELOG「Fixed」与 `remotion/src/engine/{DeterministicVideoTexture,assetLoader}.ts` 内注释。
* 仍未做：`lighting.exposure` 随帧衰减（R6 建议的相机曝光关键帧）——本轮用一次性数值调参回避，后续再上关键帧。
