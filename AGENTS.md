# AGENTS.md —— dsh-video-forge 工作区约定（硬性）

本文件面向在此仓库工作的所有 agent／协作者。**与代码冲突时以本文件与 `docs/visual-quality-standard.md` 为准**。

## 0. 绝对禁令

1. **禁止调用 `dev_reload_package`**。本机历史上它会让 DSH 主进程永久挂起（fiber 等待超时），
   只能强杀重启。需要让插件改动生效时用：
   ```bash
   bash scripts/build.sh
   # 然后二选一：
   #   a) dev_uninject_plugin({match:'dsh-video-forge'}) + dev_inject_plugin({dir:'<WORKSPACE>/plugins/dsh-video-forge'})
   #   b) 请用户手动重启 DSH
   ```
2. **禁止硬编码任何 API Key / Endpoint / 令牌**。密钥只能来自：
   插件 config → `~/.dsh/video-forge.json` → 环境变量（`ARK_API_KEY` / `MINIMAX_API_KEY` / `DSH_FORGE_BRIDGE_TOKEN`）
   → 兼容读取 `~/.dsh/seedream.json`（seedream 插件的既有配置）。
   需要录入密钥时用 `node scripts/set-keys.mjs`（掩码输入，只打印掩码）。
3. **禁止把伪算法产物当正式成片**：亮度+Sobel 伪深度、纯亮度抠像、480P 全屏覆盖，只能出现在
   `qualityMode: 'draft'`。

## 1. 提交前必须跑

```bash
bash scripts/build.sh                     # host tsc + client tsdown
cd remotion && npx tsc -p tsconfig.json --noEmit
node scripts/check-quality.mjs            # 画质静态门禁（预设六维度 / 伪算法工作流 / 颗粒默认值）
bash comfyui-nodes/dsh-video-assets/tests/run_checks.sh   # ComfyUI 节点 + 契约单测（50 条，需 numpy/torch）
```

> `comfyui-nodes` 的测试要 ComfyUI 自带 venv 的解释器（含 numpy/torch；venv 里**没有 pytest**，
> 统一走自带 `tests/run_checks.sh`）。用 `COMFYUI_DIR`（ComfyUI 根目录）或 `DSH_PY` 指过去，
> 例如 `COMFYUI_DIR=/d/comfy\ UI bash comfyui-nodes/dsh-video-assets/tests/run_checks.sh`；
> 不设则自动回退到 `python3`，张量测试会被 skip（33 pass / 17 skip），不算通过。

## 2. 改动渲染代码后的强制视觉自检

改 `remotion/src/engine/**`、`remotion/src/presets/**`、Shader、`workflows/**`、`src/bridge/**`
中任一处，**必须**按 `docs/visual-quality-standard.md` 第 4 节跑：

1. `still.mjs` 出 0/30/60/90/120 五帧；
2. `render.mjs` 出 mp4；
3. **亲自看图**，按五项清单打分；
4. 把结论写进 `docs/visual-qa-log.md`。

只跑 `tsc` 或只看 `pngdiff=0` 就宣布完成 = 违规。

## 3. 结构与契约

* `src/core/**`（providers / scheduler / cache / comfy client）**必须与风格无关**：
  不出现 three、镜头、调色、风格名。
* 跨进程只有两份 JSON 契约：`RenderPlan`（`src/bridge/render-plan.ts` ↔ `remotion/src/plan/types.ts`）
  与 `TaskManifest`。两边各自实现、**同一份 fixture 做契约测试**，改一侧必须同步另一侧。
* `remotion/src/plan/parse.ts` 是防御式解析器：可修的问题自愈（给默认值），结构错误才记 `error`。
* 风格参数只能进 `presets/style.ts` 的 `StyleSpec`；上游提示词只能进 `src/bridge/style-prompts.ts`，
  两侧预设 **id 必须一致**。

## 4. 渲染管线铁律（踩过的坑）

| 坑 | 铁律 |
| --- | --- |
| 贴图永远不加载 | 资源加载只能走 `assetLoader`（渲染期同步 `delayRender`）；`useEffect` 里挂门闩永远太晚 |
| 换完材质截图没变 | `@remotion/three` 渲染期 `frameloop='never'`，必须 `SceneKicker` 手动 `advance()` |
| 画面整片发灰 | 自写 ShaderMaterial 不会自动 sRGB 编码；`COMPOSITE_FRAG` 里 ACES 后必须转 sRGB |
| 画面糊 | 图层尺寸必须 `frameAt(distance, fov, aspect)` 推导，禁硬编码 30×16.9 |
| 一图两层 = 撕裂 + 发灰 | 有 `plate` 时远景只用 plate；主体层才用带 matte 的静帧 |
| jpg 当视频用 → 30s 超时 | 视频只喂真视频；失败要 `failed` 闩死，禁止每帧重试 |
| 视频上下颠倒 | `VideoTexture.flipY = false` |
| 共享贴图只通知第一个组件 | 缓存里存 `listeners: Set`，一对多广播 |
| 同帧两次不一致 | 禁用 `clock.elapsedTime`，用 `localFrame/fps` |

## 5. 成本纪律

* 真机验证优先用最便宜的档位（`5.0-flash`、`MiniMax-H3-Lite 480P/4s`）。
* 重复验证先用 `mock: true` 或 `useCache: true`；确认管线通了再花真钱。
* 每轮真机调用后记录：`planId`、provider 调用次数、耗时、成本档位（写进 `docs/visual-qa-log.md`）。
