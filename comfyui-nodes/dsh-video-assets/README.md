# dsh-video-assets

DSH Video-Forge 的 **ComfyUI 自定义节点包**：一组「低内存、零新依赖、可降级」的素材处理节点 + 一个参数化 / HTTP 桥节点。

- 只用 ComfyUI venv 里本来就有的 `torch / numpy / PIL`，**不装任何新包**
- 目标机器：ComfyUI 0.42.0 / Python 3.12.10 / torch 2.11.0+cu128 / **RTX 5060 Laptop 8GB VRAM / 15.8GB RAM**
- **绝不自动下载权重**：深度模型只在本地目录发现时才加载，找不到就用便宜的伪深度（info 里明确写 `method=fallback`）
- 无前端 JS（不声明 `WEB_DIRECTORY`），前端通过 `/object_info` 与 `DshWorkflowManifest` 发现本包

```
dsh-video-assets/
├── __init__.py        # NODE_CLASS_MAPPINGS / 显示名 / 版本，import 时不依赖 ComfyUI
├── common.py          # 张量↔numpy、设备选择、缩放、Sobel、box blur、info 字符串
├── assets.py          # A 组：深度/法线/遮罩/无缝/体检
├── bridge.py          # B 组：模板注入/Forge 桥/工作流清单
├── requirements.txt   # numpy + pillow（已有），可选模型依赖全部注释
├── README.md
└── tests/
    ├── test_nodes.py  # unittest（纯 Python 测试 + 张量测试分层）
    └── run_checks.sh  # 自动挑 python 跑测试，逐条打印 PASS/FAIL
```

---

## 1. 安装

目标位置：`<COMFYUI_DIR>\ComfyUI\custom_nodes\dsh-video-assets`
（`<COMFYUI_DIR>` = 你的 ComfyUI 安装根目录；下文与仓库脚本都沿用这个占位符。）
推荐 **junction（目录联接）**，改代码后重启即生效，不用反复复制：

```cmd
:: 管理员 cmd
mklink /J "<COMFYUI_DIR>\ComfyUI\custom_nodes\dsh-video-assets" "<WORKSPACE>\plugins\dsh-video-forge\comfyui-nodes\dsh-video-assets"
```

PowerShell 等价写法：

```powershell
New-Item -ItemType Junction -Path "<COMFYUI_DIR>\ComfyUI\custom_nodes\dsh-video-assets" `
  -Target "<WORKSPACE>\plugins\dsh-video-forge\comfyui-nodes\dsh-video-assets"
```

不想用 junction 就直接复制整个目录过去（每次改代码都要重新复制）。

然后：

1. **重启 ComfyUI**（0.42 默认自动加载 `custom_nodes`，不需要额外参数）。
   如果你启动时加过 `--disable-custom-nodes`，把它去掉。
2. 启动日志里搜索 `dsh-video-assets`，应出现 `IMPORT OK` 之类的记录，**不应**出现 Traceback。

## 2. 验证是否加载成功

```cmd
curl http://127.0.0.1:8188/object_info | findstr Dsh
```

PowerShell：

```powershell
(Invoke-RestMethod http://127.0.0.1:8188/object_info).PSObject.Properties.Name -match '^Dsh'
```

应列出 8 个名字：`DshDepthEstimate / DshNormalFromDepth / DshAlphaMatte / DshSeamlessTiling / DshAssetInspect / DshTemplateInject / DshForgeBridgeCall / DshWorkflowManifest`。

前端（TS 桥）也可以直接拉清单：

```cmd
curl http://127.0.0.1:8188/object_info/DshWorkflowManifest
```

或在工作流里跑一次 `DshWorkflowManifest`，它的 `manifest_json` 输出就是本包的机器可读描述（包名/版本、每个节点的输入默认值与输出契约、占位符键、推荐管线、内存建议）。

## 3. 节点一览

A 组分类 `dsh/video-assets`，B 组分类 `dsh/bridge`。

| 节点 | 输入（默认值） | 输出 |
| --- | --- | --- |
| **DshDepthEstimate** 深度估计 | `image`，`device`=["auto","cpu","cuda"]，`max_side`=1024 (256..2048)，可选 `use_model`=false、`model_path`="" | `depth` IMAGE（灰度→RGB，尺寸同输入）、`info` STRING |
| **DshNormalFromDepth** 法线(由深度) | `depth` IMAGE，`strength`=1.5 (0..8)，`flip_green` BOOL，可选 `invert_depth`=false | `normal` IMAGE（切线空间法线，编码 `n*0.5+0.5`） |
| **DshAlphaMatte** 透明遮罩 | `image`，`mode`=["luma_key","chroma_key","threshold"]，`threshold`=0.5，`edge_feather`=0 (0..64)，可选 `key_color`="#00FF00"、`tolerance`=0.15、`softness`=0.05、`invert`=false | `rgba` **IMAGE 4 通道**、`mask` MASK `[B,H,W]` |
| **DshSeamlessTiling** 无缝贴图 | `image`，`mode`=["wrap_blend","mirror","edge_blend"]，`blend_px`=64 (0..512) | `image` IMAGE（尺寸不变） |
| **DshAssetInspect** 素材体检 | `image`，`max_side`=256 (32..1024)，`top_colors`=5 (1..16) | `json` STRING |
| **DshTemplateInject** 模板注入 | `template` STRING 多行，`payload` STRING 多行 `{}`，`strict`=false | `text` STRING、`report` STRING(JSON) |
| **DshForgeBridgeCall** Forge 桥调用 | `endpoint`=http://127.0.0.1:8068/api/dsh-video-forge/bridge，`action`=["seedream_t2i","minimax_t2v","minimax_i2v","forge_task","health"]，`params_json` 多行 `{}`，`api_key_env`="DSH_FORGE_TOKEN"，`timeout_sec`=120 (1..600)，可选 `dry_run`=false | `response_json` STRING、`status` STRING |
| **DshWorkflowManifest** 工作流清单 | `extra_json` 多行 `{}` | `manifest_json` STRING |

`OUTPUT_NODE`：只有「输出纯字符串」的 4 个 B 组节点与 `DshAssetInspect` 为 `true`，图像节点均为 `false`（它们是中间节点）。

### 数据约定（ComfyUI 真实约定）

- IMAGE = `[B, H, W, C]`，`torch.float32`，值域 `0..1`
- MASK = `[B, H, W]`，`float32`，值域 `0..1`
- **4 通道 IMAGE 的第 4 通道就是 alpha**：本包 `DshAlphaMatte` 输出 4 通道 IMAGE，前端 / 外部客户端按第 4 通道读 alpha。注意 ComfyUI 自带的 `SaveImage` / `PreviewImage` 只取前 3 通道，看不到透明度——要落盘带 alpha 的 PNG 请接 `SaveImage` 前先用 `mask` 输出，或在外部管线里读 4 通道。

## 4. 占位符语法（DshTemplateInject）

语法：

| 写法 | 含义 |
| --- | --- |
| `${a.b.c}` | 按点路径取 `payload` 里的值（dict 用键，list 用数字下标，如 `${images.0.seed}`） |
| `${a.b.c:默认值}` | 取不到时用 `:` 后面的默认值（会 trim 首尾空格） |
| `\${a.b.c}` | 转义：原样输出 `${a.b.c}`，不做替换（`\\` 就是字面反斜杠） |

取值编码规则：字符串原样、`true/false`、数字最多 10 位有效数字、对象/数组输出**紧凑 JSON**、`null` 输出空串。
取不到的键：非 strict 模式下**原样保留** `${...}` 文本并记进 `report.unresolved`；strict 模式直接 `ValueError`，错误信息里列全部未解析键。

`report` 示例：

```json
{"resolved":["job.id","prompt"],"unresolved":["negative"],"fallbacks":[],
 "escaped":0,"placeholders":3,"output_length":57}
```

例如模板是一段 ComfyUI API 格式的 workflow JSON，外部管线只替换少量占位符：

```
{"3":{"inputs":{"seed":${job.seed},"text":"${prompt}","negative":"${negative:blurry}"}}}
```

`payload = {"job":{"seed":12345},"prompt":"赛博朋克街道"}` → 输出把 `${job.seed}` 换成 `12345`、`${negative:blurry}` 换成 `blurry`。

> 提示：占位符只做**文本替换**，不做类型推断——`"${job.seed}"`（带引号）会得到字符串 `"12345"`，JSON 数字请写成 `"seed":${job.seed}`。

## 5. 外部管线怎么调 DshForgeBridgeCall

节点内部就是这么一条 HTTP 请求（`urllib.request`，std-lib，不用 requests）：

```http
POST http://127.0.0.1:8068/api/dsh-video-forge/bridge
content-type: application/json
authorization: Bearer <env DSH_FORGE_TOKEN 的值>   ← 只在 env 非空时添加

{"action":"seedream_t2i","params":{"prompt":"赛博朋克街道","width":1024}}
```

等价的 curl（对照调试用）：

```cmd
curl -s -X POST http://127.0.0.1:8068/api/dsh-video-forge/bridge ^
  -H "content-type: application/json" ^
  -H "authorization: Bearer %DSH_FORGE_TOKEN%" ^
  -d "{\"action\":\"seedream_t2i\",\"params\":{\"prompt\":\"赛博朋克街道\"}}"
```

节点输出：

- `response_json`：HTTP 响应体原文（字符串）。**HTTP 4xx/5xx 也不会抛异常**，body 照样回传。
- `status`：给人看的一行状态：
  - `200 ok`
  - `error: HTTP 500 internal server error: <body 前 160 字符>`
  - `error: timeout after 120s`
  - `error: url: ...`
  - `dry-run health 34B auth=no`（`dry_run=true` 时只回预览，不发请求、不带 token；`auth=yes/no` 只表示环境变量里有没有 token）

安全约定：token 只从**环境变量**读（`api_key_env` 指定变量名，默认 `DSH_FORGE_TOKEN`），从不入参、不入日志、不进 `status` / 预览 JSON。

典型编排（外部管线把参数灌进 ComfyUI 工作流）：

```
DshTemplateInject(template=workflow_json, payload=job_json)
        └─ text ──────────────► 作为 params_json 喂给 DshForgeBridgeCall
DshForgeBridgeCall(action="seedream_t2i", params_json=<上面的 text>, api_key_env="DSH_FORGE_TOKEN")
        └─ response_json ─────► LoadImage / 外部管线解析
```

`health` 动作用来探活：`status` 以 `200` 开头就说明桥在线。

## 6. 8GB VRAM / 16GB RAM 内存纪律

硬规则（代码里已经实现）：**永远先缩到 `max_side` 再算，算完再放大回原尺寸**；全程 float32；中间张量算完即 `del` 并 `comfy.model_management.soft_empty_cache()`；深度模型缓存最多 1 份；不自动下载权重。

建议档位：

| 场景 | 建议设置 |
| --- | --- |
| 只跑 A 组轻量节点（无大模型） | `max_side=1024`（默认），batch ≤ 4 |
| 同时挂着 SDXL / 视频模型（显存吃紧） | 深度 `max_side=512~768`，`device=cpu`（伪深度走 CPU 也很快），batch ≤ 2 |
| 4K 贴图 / 大图批处理 | `max_side=2048`（上限），batch=1，逐张过 |
| 只想让前端做决策（来料检查） | `DshAssetInspect` 固定 `max_side=256`，几十毫秒 |
| 高分辨率 + 有其它大模型常驻 | 先 `DshAssetInspect` 看尺寸，>2048 先缩图，再进深度/法线 |

其它注意：

- `device=auto` → 有 CUDA 用 CUDA，没有就 CPU；`device=cuda` 但 CUDA 不可用会**自动退到 CPU** 并在 `info` 里写 `dev_reason=cuda-unavailable`，不会崩。
- 深度模型（如果装了）走 `transformers.pipeline(..., local_files_only=True)`，只认 ComfyUI `folder_paths` 里 `depth_anything / depthanything / depth / depth_models / models/depth_anything` 目录下「`config.json` + 权重文件」的**本地**模型；本地没有就回退，不会联网。
- 无缝贴图的 `mirror` 模式会丢掉 3/4 内容（只保留左上 1/4 再镜像拼接），适合程序化纹理，不适合保留主体；保留细节用默认 `wrap_blend`。

## 7. 降级行为表（重要）

| 节点 | 缺失/异常条件 | 行为 | 证据 |
| --- | --- | --- | --- |
| DshDepthEstimate | 没有本地深度模型 | 用「亮度 0.72×模糊 + 0.28×Sobel 边缘」伪深度（白=近） | `info` 里 `method=fallback reason=no-model` |
| DshDepthEstimate | `use_model=true` 但目录里没有模型 | 同上，不报错、不下载 | `reason=no-local-model` 或 `model-path-missing` |
| DshDepthEstimate | transformers 缺失 / 加载或推理抛异常 | 捕获 → 回退伪深度，异常摘要进 info | `reason=load-failed:<Exc>` / `run-failed:<Exc>` |
| DshDepthEstimate | 请求 cuda 但 CUDA 不可用 | 退 CPU | `device=cpu dev_reason=cuda-unavailable` |
| DshDepthEstimate | 图片长边 > `max_side` | 先缩到 `max_side` 处理，再 bilinear 放回原尺寸 | `info` 里 `proc=WxH orig=WxH` |
| DshNormalFromDepth | 输入是彩色 | 先取 BT.601 亮度当深度 | 无（纯 numpy） |
| DshAlphaMatte | 输入 3 通道 | 输出 4 通道（alpha 由 key 算） | `rgba` 通道数 = 4 |
| DshAlphaMatte | 输入本来就有 alpha | 与算出的 alpha **相乘**（不丢弃原透明度） | 可用 `DshAssetInspect.alpha_min` 验证 |
| DshAlphaMatte | chroma 模式 + 非纯色背景 | 用 `tolerance/softness` 的 smoothstep 过渡，效果取决于底色纯度 | 输出 `mask` 看直方图 |
| DshSeamlessTiling | `blend_px=0` | 该模式退化为「不混合」（mirror 仍做镜像拼接） | 输出尺寸不变 |
| DshSeamlessTiling | 非方形 / 奇数尺寸 | 内部裁/补到原尺寸 | 输出尺寸不变 |
| DshAssetInspect | 大图 | 按 `max_side` 步进采样（不读全图），几十毫秒 | JSON `sample.step` |
| DshTemplateInject | 缺键 + 非 strict | 原样保留 `${...}` | `report.unresolved` |
| DshTemplateInject | 缺键 + strict=true | `ValueError`（列出全部未解析键，工作流报错停止） | 异常文本 |
| DshTemplateInject | payload 非法 JSON | `ValueError` | 异常文本 |
| DshForgeBridgeCall | HTTP 4xx/5xx | **不抛异常**，回传 body + `status=error: HTTP ...` | status 前 160 字符是 body 摘要 |
| DshForgeBridgeCall | 连接失败 / 超时 | 回传空 body + `status=error: ...` | 不阻塞工作流跑挂 |
| DshForgeBridgeCall | 环境变量未设置 | 不带 `authorization` 头（由服务端决定是否 401） | `dry_run` 预览里 `auth=false` |
| 任意张量节点 | 裸 Python（无 numpy/torch） | 包能 import，**执行时才** `RuntimeError` 并给出中文提示 | 测试 `test_import_without_numpy_and_torch` |

## 8. 自测

ComfyUI 的 venv 里跑（numpy/torch 都在，张量测试会真跑）：

```cmd
cd /d "<WORKSPACE>\plugins\dsh-video-forge\comfyui-nodes\dsh-video-assets"
"<COMFYUI_DIR>\venv\Scripts\python.exe" -m unittest discover -s tests -t . -v
```

自动挑解释器 + 逐条 PASS/FAIL：

```cmd
bash tests/run_checks.sh
:: 指定解释器（COMFYUI_DIR 也可以直接由环境变量提供）
set DSH_PY=<COMFYUI_DIR>\venv\Scripts\python.exe && bash tests/run_checks.sh
```

已知基线：

- 带 numpy/torch 的解释器（ComfyUI 自带 venv，或 `pip install -r requirements.txt` 后的 python）：**50 tests, OK, 0 skip**
- 无 numpy 的裸 Python（`python3` / 系统 python）：33 通过 + 17 个张量测试 skip（纯 Python 测试：import 安全、模板注入、清单、HTTP 桥）

测试覆盖：8 节点契约（INPUT_TYPES/RETURN_TYPES/FUNCTION/CATEGORY/docstring）、裸 Python import 安全、模板注入（嵌套/默认值/转义/strict）、清单 JSON schema、HTTP 桥（本地 `http.server` stub：成功、Bearer、4xx/5xx 不抛、连接拒绝、超时、dry_run、非法参数不发请求）、张量节点（尺寸/回放原尺寸/法线单位长度与 flip_green/alpha 各种模式与羽化/无缝三种模式的接缝归零/体检 JSON）。

## 9. 排错

| 现象 | 处理 |
| --- | --- |
| 节点列表里没有 DSH 节点 | 确认 `custom_nodes\dsh-video-assets\__init__.py` 存在；看启动日志有没有 Traceback；确认启动参数没有 `--disable-custom-nodes` |
| `object_info` 里搜不到 | 改完文件必须重启 ComfyUI（本包无前端 JS，不需要清浏览器缓存） |
| 桥返回 401 | 环境变量没设或名字写错：`set DSH_FORGE_TOKEN=...` 后**重启 ComfyUI**（环境变量在进程启动时读取） |
| 桥 `status=error: timeout after Ns` | 外部服务没起来或很慢：先用 `action=health` 探活；把 `timeout_sec` 调大 |
| 深度不出效果 | 看 `info`：`method=fallback` 说明走的是伪深度，属正常降级；想要真深度需自备本地模型 |
| 显存 OOM | 降 `max_side`（512/768）、batch 变小、`device=cpu`；本包不做全尺寸计算，但下游模型仍可能占显存 |
| 4 通道 IMAGE 看不到透明 | ComfyUI 自带预览只显示 RGB，alpha 看 `mask` 输出或外部读取第 4 通道 |
