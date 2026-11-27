# Video Forge · 渲染内核（Remotion + Three.js）

风格无关的确定性视频舞台。输入是一份 **RenderPlan JSON**，输出是 Remotion `<Composition>`。

这一层**不认识** Seedream / MiniMax / ComfyUI，也不知道谁生成的图；它只知道：

- 每个镜头有多长、怎么运镜；
- 画面上有哪些贴图层（静帧 / 深度 / 遮罩 / 视频）；
- 用哪个 `preset`（空间舞台）和哪些后处理 Pass。

---

## 1. 快速开始

```bash
cd plugins/dsh-video-forge/remotion
npm install

npm run studio      # 打开 Remotion Studio
npm run typecheck   # tsc --noEmit
```

Studio 里有 5 个 Composition：

| Composition | 输入 | 用途 |
| --- | --- | --- |
| `VideoForge` | `--props='{"plan": <plan JSON>}'`（或 `planPath`） | 渲染真实生产的 plan（host 已写入 `public/forge/`） |
| `Demo-Spatial` | 内置 demo plan | 验证 Preset A（空间纵深 + 实例化阵列） |
| `Demo-Parallax` | 内置 demo plan | 验证 Preset B（2.5D 分层视差 + 视频叠加） |
| `Demo-VideoFirst` | 内置 demo plan | 验证 Preset C（H3 直出视频贴空间） |
| `Demo-VideoClip` | 内置 `forge/videotest/clip.mp4`（真实 H3 产出） | 验证 `<DeterministicVideoTexture>` 帧同步 |

渲单帧走包装脚本（推荐，它会把 plan 整份内联进 `--props`、自动找 Chrome）：

```bash
# 真实 plan：node scripts/still.mjs <plan.json> <帧号> <输出 png>
node scripts/still.mjs public/forge/<planId>/plan.json 40 out/frame40.png

# 内置 Composition：--composition=<id>
node scripts/still.mjs --composition=Demo-Spatial 40 out/spatial.png

# 渲成 mp4：node scripts/render.mjs <plan.json> <输出 mp4> [--frames=0-119] [--crf=18]
node scripts/render.mjs public/forge/<planId>/plan.json out/film.mp4
node scripts/render.mjs --composition=Demo-VideoClip out/demo.mp4
```

脚本内部就是 `node node_modules/@remotion/cli/remotion-cli.js still ... --browser-executable=<Chrome>`：

> 两个 Windows/MSYS 坑：① `npx remotion ...` 会被 `C:\Program Files\nodejs` 的空格打断（静默 exit 0）；
> ② Remotion 自带的 Chrome Headless Shell 在受限网络下会卡在下载，必须 `--browser-executable`
> 指向本机 Chrome / Edge。`scripts/still.mjs` 把这两件事都处理了。

> **渲 mp4 与临时目录**：`render.mjs` / `still.mjs` 会把子进程的 `TEMP`/`TMP`/`TMPDIR`
> 统一指到 `~/.dsh/video-forge/tmp`（见 `scripts/_tmp.mjs`）。原因是 Git-Bash 里 `TEMP=/tmp`
> 这种 MSYS 路径会被 Windows 原生子进程按「当前盘符 + Git 安装目录」解析成
> `C:\Program Files\Git\tmp`：该目录不存在 → `ENOENT ... mkdtemp`，存在但不可写 → `Permission denied`，
> 而这个 `mkdtemp` 是 Remotion **建 Chrome 用户目录**那一步，渲染会在出第 0 帧前就退出。
> 历史记录把这条错误归因成「ffmpeg 生成静音 wav 失败」，实测不成立。
>
> 音轨**默认保留**（片源有音轨就带进成片，供 MAGI-2 / H3 原生音画同步用）；想显式静音加 `--muted`。

---

## 2. 图形原语（4 个，跨风格）

| 原语 | 文件 | 能力 |
| --- | --- | --- |
| `DepthParallaxLayer` | `src/engine/DepthParallaxLayer.tsx` | 吃深度图做顶点位移 + 相机驱动的 UV 视差；吃 Alpha 遮罩做抠像；多层（`layers`/`layerGap`）错层；`edgeBoost` 出轮廓；分段数随 `parallax` 自适应 |
| `InstancedSpatialField` | `src/engine/InstancedSpatialField.tsx` | `InstancedMesh` 大规模阵列（box/tetra/plane/sphere），确定性 `mulberry32(seed)` 布点、呼吸位移、lambert+rim 光照、指数**大气透视雾**（`pow(fog,uFogPower)`） |
| `ComposablePostFX` | `src/engine/ComposablePostFX.ts` | **注册表**而非组件：`PASS_REGISTRY`（bloom/glow/grade/film/clean/dof/vignette/warm/cold）+ `MATERIAL_STYLES`（natural/edge/ink/duotoneWarm/duotoneCold），`registerPass()` / `registerMaterialStyle()` 运行时热插拔 |
| `MultiBlendVideoPlane` | `src/engine/MultiBlendVideoPlane.tsx` | 视频贴到平面或**曲面**（`curvature`），`normal/additive/multiply/luakay` 四种混合 + chroma key + lumaBoost |

后处理管线（`src/engine/postfx.ts`）实现同 `EffectComposer` 语义的 `PostChain`：`bright → blurH → blurV → composite`（HalfFloat RT），composite 里合并 bloom、6 环径向 DOF、色彩分级（lift/gain/exposure/contrast/saturation）、暗角、胶片颗粒与 ACES 近似。

**为什么不用 `postprocessing` 的 `EffectComposer`**：转场需要在**一帧内**渲染两个场景到两张 RT 再混合，而 `EffectComposer` 假定"单场景单相机 + 自己管渲染循环"；两套循环共存会在 headless Chrome 里出现 RT 未清、色彩空间不一致，且多一个运行时依赖。自研 PassChain 是零依赖、确定性的。

---

## 3. 确定性帧同步（整个工程最容易踩坑的地方）

AI 视频（MiniMax H3 / ComfyUI 输出）不能"自由播放"，否则离线渲染的每一帧与 3D 运镜对不上。

### 3.1 三条硬纪律

1. **门闩必须在渲染期挂**。Remotion 只认渲染期同步调用的 `delayRender()`；写在 `useEffect` 里的话，
   第一帧已经"自认为就绪"并截图了 —— 表现就是贴图永远是占位图、视频永远是第一帧，而且不报错。
   所以 `src/engine/assetLoader.ts` 的所有 `acquire*()` 都在 `useMemo`（渲染期）里调用。
2. **门闩清空后 Remotion 不会重渲染 React 树**。资源到位后必须 `setState` 触发一次重渲染
   （`useForgeTexture` 里的 `version` 版本号），否则新材质永远不会被创建。
3. **React 重渲染也不等于重绘 canvas**。`@remotion/three` 在渲染期把 R3F 设成 `frameloop: 'never'`，
   只在 `useCurrentFrame()` 变化时 `advance()` 一次。资源就绪后要主动踢一帧，
   否则截图拍到的还是上一张占位画面 —— 这是 `src/engine/SceneKicker.tsx` 存在的唯一理由
   （`assetLoader.releaseAfterPaint()` 会在放行 `delayRender` 前先 kick 一次）。

完整时序：`acquireTexture()` 挂门闩 → `fetch` + `createImageBitmap` → 落到 canvas（`THREE.Texture(bitmap)`
在 headless Chrome 里会传成黑图，必须走 `CanvasTexture`）→ 通知**所有**共用这张贴图的组件
（`listeners` 集合；同一个 still 会被远/中景多层共用）→ 各自 `setState` → rAF 里 kick → 再 rAF → `continueRender()`。

### 3.2 视频

`useDeterministicVideo(src, offsetSeconds, playbackRate)`：

1. 离屏 `<video muted playsInline preload="auto" crossOrigin="anonymous">`，**不调用 play()**；
2. 每帧 `delayRender('video-forge:video:<src>@<frame>')`；
3. `currentTime = (frame / fps) * playbackRate + offsetSeconds`，等 `seeked`；
4. `texture.needsUpdate = true` + kick + `continueRender()`；
5. 3s 超时兜底（坏编码不能卡死整条渲染）；一旦判定失败就 `status='failed'` 不再重试，
   否则每帧 3s 会一路累积到 Remotion 的 30s 全局超时；
6. `VideoTexture.flipY = false` —— 默认值会把 H3 出片整帧上下颠倒（实测）。

> WebCodecs 预解码属于后续增强项；当前以 `seeked` 为准，配合 `--concurrency=1` 足够稳。

### 3.3 怎么验证"真的对上了"

```bash
node scripts/still.mjs public/forge/<planId>/plan.json 40 out/a.png
node scripts/still.mjs public/forge/<planId>/plan.json 40 out/b.png
node scripts/pngdiff.mjs out/a.png out/b.png     # 期望 maxDiff 0 / changed 0.00%
```

同一帧两次渲染必须逐像素一致（本仓库实测：静帧场景与视频场景都是 `maxDiff 0`）。
以前的实现里 `InstancedSpatialField` 用了 `state.clock.elapsedTime`（真实时钟）做微旋转，
每帧会差 0.5% 像素 —— 现在一切都从 `localFrame / fps` 推导。

---

## 4. 运镜与转场

- `src/engine/camera.ts`：`CameraPath` 用 `THREE.CatmullRomCurve3`（catmullrom、tension 0.5）串起 `from → mid+侧向弧线 → to`，LookAt 滞后 12% 做阻尼，避免"直角拐弯"；`ease()` 支持 `smooth`（smootherstep）/`linear`/`easeInOut`。
- `src/engine/transitions.ts` + `glsl.ts` 的 `TRANSITION_FRAG`：`crossfade` / `radial-blur` / `luma-wipe`（支持 mask 图与边缘亮线）/ `noise-dissolve` / `push`。
- `src/engine/Compositor.tsx`：单路（当帧只有一个镜头）直接渲染到屏；进入转场区间后双路渲染（下一镜头定格在 `t=0`）再 `TransitionMixer` 混合，最后过 `PostChain`。

---

## 5. Preset（风格装在这里，不在内核里）

`src/presets/`：

```ts
export interface StagePreset {
  id: string
  name: string
  description: string
  postFX?: string[]                                  // PASS_REGISTRY 里的 id
  build(ctx: PresetBuildContext): ReactNode          // 空间怎么搭
  background?(ctx): string | null                    // 背景色/雾色
  postFXConfig?(ctx): Partial<PostFXConfig>          // 覆盖 bloom/grain/…
}
```

- **`spatial`（Preset A）**：天幕 + 地面 + 两层实例化阵列（420 box / 160 tetra）+ 大气雾 → 空间纵深；`grade + bloom + film`。
- **`parallax`（Preset B）**：远景/中景多层 2.5D 视差（吃 depth/matte）+ 视频叠加曲面 + 前景高光带 → 层次感；`grade + glow`。
- **`video-first`（Preset C）**：弧幕视频主体 + 球形微粒 + 顶部柔光 → H3 直出片；无视频时用静帧兜底防黑屏。

注册自定义 preset：

```ts
import { registerPreset } from './presets'
registerPreset({ id: 'my-style', name: '我的风格', description: '…', build: () => …, postFX: ['grade'] })
```

`Compositor` 对 `strategy === 'minimax-direct'` 的镜头会自动切到 `video-first`。

---

## 6. RenderPlan 契约

`src/plan/types.ts` + `src/plan/parse.ts` 是契约的**独立镜像**（host 侧另有一份 `src/bridge/render-plan.ts`），两边用同一份夹具 `fixtures/render-plan.example.json` 做契约测试，由 `scripts/check-plan.mjs` 检查。

关键约定：

- `shots[].from` / `durationInFrames` 决定时间轴；重叠会被 `parseRenderPlan` 自动重排并给 warn；
- `camera.from/to` **必须是 `{position:[x,y,z], lookAt:[x,y,z]}`**，给裸数组会被忽略（回落默认机位）；
- `layer.src` 不能是空串（空串会当作"没有层"）；
- 资产路径是 `public/` 下的 POSIX 相对路径（如 `forge/<planId>/xxx.png`），走 Remotion `staticFile()`；host 会把产物硬链接进 `remotion/public/forge/<planId>/`；
- `parseRenderPlan` 永不 throw：能修的修（补 fov=42、补 static 机位、重排时间轴），修不了才记 `level:'error'`。

---

## 7. 坐标与单位

- 世界单位 ≈ 米，默认相机 fov 42°；
- 静帧层默认放在 `z≈-8`、宽 30 × 高 16.9（16:9），视频平面默认宽 20 × 高 11.25；
- 雾色默认取 `plan.style.fogColor`，背景取 `plan.style.background`；
- 所有随机（粒子布点、颗粒）都必须走 `mulberry32(seed)`，**禁止 `Math.random()` / `Date.now()`**（否则同一帧两次渲染结果不同，Remotion 会告警甚至出闪烁）。
