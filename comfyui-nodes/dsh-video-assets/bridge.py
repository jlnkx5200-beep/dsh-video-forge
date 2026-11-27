"""dsh-video-assets —— API 桥 / 参数化节点（B 类）。

节点：DshTemplateInject / DshForgeBridgeCall / DshWorkflowManifest

目标：让外部 AI-video 管线（Seedream 图 -> ComfyUI 素材 -> MiniMax 视频 -> 渲染）
可以在**工作流图内部**做占位符注入、调用 Video-Forge host API、并自描述节点契约。

纪律：
* 只用 stdlib（`json` / `re` / `urllib.request`），不引入 requests；
* HTTP 错误绝不抛异常 —— 一律以 `(body, status)` 返回，工作流可继续；
* 绝不把 token 写进返回值 / status / 日志。
"""
from __future__ import annotations

import json
import math
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:  # 作为包的一部分被 import（ComfyUI 的加载方式）
    from . import common as C
except ImportError:  # 兼底：被当作顶层模块加载时
    import common as C  # type: ignore


def _default_endpoint() -> str:
    """桥接地址：优先 `DSH_FORGE_ENDPOINT`，其次 `DSH_FORGE_PORT`（默认 8068）。

    DSH 的 Web 端口每次启动可能不同（本机曾从 8068 漂到 8977），写死端口会让
    节点在换端口后静默连不上，所以这里留了两个环境变量出口。
    """
    explicit = os.environ.get("DSH_FORGE_ENDPOINT", "").strip()
    if explicit:
        return explicit
    port = os.environ.get("DSH_FORGE_PORT", "8068").strip() or "8068"
    return f"http://127.0.0.1:{port}/api/dsh-video-forge/bridge"


DEFAULT_ENDPOINT = _default_endpoint()
DEFAULT_AUTH_ENV = "DSH_FORGE_TOKEN"
BRIDGE_ACTIONS = ["seedream_t2i", "minimax_t2v", "minimax_i2v", "forge_task", "health"]


# ---------------------------------------------------------------------------
# 1) 占位符模板注入
# ---------------------------------------------------------------------------
_MISSING = object()
# `\X` 转义 + `${...}` 占位符；花括号内不允许再嵌套花括号（够用且可预测）
_TOKEN_RE = re.compile(r"\\(.)|\$\{([^{}]*)\}", re.S)


def _dedup(seq):
    out, seen = [], set()
    for item in seq:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _lookup(payload, path: str):
    """点路径取值：dict 按键、list 支持数字 index；不存在 -> _MISSING。"""
    current = payload
    for part in str(path).split("."):
        if part == "":
            continue
        if isinstance(current, dict):
            if part not in current:
                return _MISSING
            current = current[part]
        elif isinstance(current, (list, tuple)):
            try:
                current = current[int(part)]
            except (ValueError, IndexError, TypeError):
                return _MISSING
        else:
            return _MISSING
    return current


def _format_value(value) -> str:
    """标量 -> 原样文本；对象/数组 -> 紧凑 JSON。"""
    if isinstance(value, str):
        return value
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return ""
        return ("%.10g" % value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def resolve_template(template, payload, strict: bool = False):
    """实现 `${a.b.c}` / `${VAR:fallback}` / `\\${literal}`。

    返回 `(text, report_dict)`。strict=True 且存在无法解析的占位符时抛 ValueError。
    """
    text = "" if template is None else str(template)
    data = payload if payload is not None else {}
    if not isinstance(data, dict):
        raise ValueError("payload 必须是 JSON 对象（dict）")

    resolved, unresolved, fallbacks = [], [], []
    escaped = 0
    pieces = []
    pos = 0
    for match in _TOKEN_RE.finditer(text):
        pieces.append(text[pos:match.start()])
        pos = match.end()
        if match.group(1) is not None:  # `\X` 转义
            pieces.append(match.group(1))
            escaped += 1
            continue
        expr = (match.group(2) or "").strip()
        path, sep, fallback = expr.partition(":")
        path = path.strip()
        value = _lookup(data, path) if path else _MISSING
        if value is not _MISSING:
            pieces.append(_format_value(value))
            resolved.append(path)
        elif sep:
            pieces.append(fallback.strip())
            fallbacks.append(path)
        else:
            pieces.append(match.group(0))  # 原样保留，方便下游排查
            unresolved.append(path)
    pieces.append(text[pos:])
    out_text = "".join(pieces)

    report = {
        "resolved": _dedup(resolved),
        "unresolved": _dedup(unresolved),
        "fallbacks": _dedup(fallbacks),
        "escaped": escaped,
        "placeholders": len(resolved) + len(fallbacks) + len(unresolved),
        "output_length": len(out_text),
    }
    if strict and report["unresolved"]:
        raise ValueError(
            "DshTemplateInject: 无法解析的占位符: " + ", ".join(report["unresolved"])
        )
    return out_text, report


def _parse_payload_json(payload, where: str = "payload") -> dict:
    """payload STRING -> dict。空串视作 {}；非法 JSON / 非对象 -> ValueError。"""
    raw = "" if payload is None else str(payload)
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except Exception as exc:
        raise ValueError(f"{where} 不是合法 JSON: {type(exc).__name__}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{where} 必须是 JSON 对象，实际是 {type(data).__name__}")
    return data


class DshTemplateInject:
    """占位符注入：把 payload 注入模板文本。

    输入
    ----
    template : STRING（多行）模板文本
    payload  : STRING（多行）JSON 对象
    strict   : BOOLEAN，True 时只要还有无法解析的占位符就抛 ValueError（列出全部 key）

    语法
    ----
    `${a.b.c}`     点路径取值（dict 键 / list 下标）
    `${VAR:兜底}`  取不到时用冒号后的兜底值（不进入 unresolved，记入 fallbacks）
    `\\${literal}`  反斜杠转义，原样输出 `${literal}`；`\\\\` 输出单个 `\\`

    取值编码：字符串原样；true/false；整数/浮点（%.10g）；对象/数组 -> 紧凑 JSON。

    输出
    ----
    text   : STRING 解析后的文本（未解析的占位符原样保留）
    report : STRING JSON `{resolved, unresolved, fallbacks, escaped, placeholders, output_length}`
    """

    CATEGORY = "dsh/bridge"
    FUNCTION = "inject"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "report")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": ("STRING", {"default": "", "multiline": True}),
                "payload": ("STRING", {"default": "{}", "multiline": True}),
                "strict": ("BOOLEAN", {"default": False}),
            },
            "optional": {},
        }

    def inject(self, template="", payload="{}", strict=False, **_kwargs):
        data = _parse_payload_json(payload, "payload")
        text, report = resolve_template(template, data, bool(strict))
        return (text, C.json_dumps(report))


# ---------------------------------------------------------------------------
# 2) Video-Forge host API 桥
# ---------------------------------------------------------------------------
def _validate_endpoint(endpoint: str) -> str:
    ep = str(endpoint or "").strip()
    if not ep:
        raise ValueError("endpoint 为空")
    parsed = urllib.parse.urlsplit(ep)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"endpoint 必须是绝对 http(s) URL，收到: {ep!r}")
    return ep


def _resolve_token(api_key_env: str) -> str:
    name = str(api_key_env or "").strip()
    if not name:
        return ""
    return (os.environ.get(name) or "").strip()


def _build_request(endpoint, action, params, api_key_env=DEFAULT_AUTH_ENV):
    """构造 Request；返回 `(request, meta)`。meta 只含非敏感信息（绝不含 token）。"""
    ep = _validate_endpoint(endpoint)
    if not isinstance(params, dict):
        raise ValueError("params 必须是 JSON 对象")
    payload = {"action": str(action), "params": params}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": f"{C.PACK_NAME}/{C.PACK_VERSION}",
        "Content-Length": str(len(body)),
    }
    token = _resolve_token(api_key_env)
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(ep, data=body, headers=headers, method="POST")
    return request, {"has_token": bool(token), "bytes": len(body), "action": str(action)}


def _decode_body(raw) -> str:
    if not raw:
        return ""
    try:
        return raw.decode("utf-8", "replace")
    except Exception:
        return ""


def _post_json(endpoint, action, params, api_key_env=DEFAULT_AUTH_ENV, timeout_sec=120):
    """POST `{action, params}`；**永远不抛**，返回 `(body_text, status_line)`。"""
    try:
        request, _meta = _build_request(endpoint, action, params, api_key_env)
    except Exception as exc:
        return "", f"error: {exc}"

    timeout = float(C.clamp_int(timeout_sec, 1, 600, 120))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = _decode_body(response.read())
            code = getattr(response, "status", None) or response.getcode()
            reason = getattr(response, "reason", "") or ""
            status = f"{code} {str(reason).strip().lower()}".strip()
            return body, status
    except urllib.error.HTTPError as exc:  # 4xx/5xx：把 body 交回去，不抛
        body = ""
        try:
            body = _decode_body(exc.read())
        except Exception:
            pass
        status = f"error: HTTP {exc.code} {str(exc.reason or '').strip().lower()}".strip()
        snippet = " ".join(body.strip().split())[:160]
        if snippet:
            status += ": " + snippet
        return body, status
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        text = str(reason)
        if isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in text.lower():
            return "", f"error: timeout after {int(timeout)}s"
        return "", f"error: url: {text}"
    except (TimeoutError, socket.timeout):
        return "", f"error: timeout after {int(timeout)}s"
    except Exception as exc:  # 任何其它问题同样不抛
        return "", f"error: {type(exc).__name__}: {exc}"


class DshForgeBridgeCall:
    """在工作流图内调用 Video-Forge host API。

    输入
    ----
    endpoint     : STRING，默认 `http://127.0.0.1:8068/api/dsh-video-forge/bridge`
    action       : seedream_t2i / minimax_t2v / minimax_i2v / forge_task / health
    params_json  : STRING（多行）JSON 对象，作为 `params` 原样转发
    api_key_env  : STRING，保存 token 的环境变量名（默认 DSH_FORGE_TOKEN）；
                   变量为空则不带 Authorization 头
    timeout_sec  : INT 1..600（默认 120）
    dry_run      : 可选 BOOLEAN，True 时不发请求，只回显将要发送的请求（不含 token）

    输出
    ----
    response_json : STRING 服务端返回的原始 body（HTTP 错误时同样返回错误 body）
    status        : STRING 短状态行 `200 ok` / `error: HTTP 500 ...` / `error: timeout after 120s`

    行为
    ----
    请求体固定为 `{"action": ..., "params": {...}}`；带 `Bearer` 时只读环境变量，
    token 绝不进入 status / response_json / 日志。**HTTP 错误不抛异常**，
    工作流可以继续跑（前端据 status 判断）。
    """

    CATEGORY = "dsh/bridge"
    FUNCTION = "call"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("response_json", "status")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "endpoint": ("STRING", {"default": DEFAULT_ENDPOINT, "multiline": False}),
                "action": (list(BRIDGE_ACTIONS), {"default": "health"}),
                "params_json": ("STRING", {"default": "{}", "multiline": True}),
                "api_key_env": ("STRING", {"default": DEFAULT_AUTH_ENV, "multiline": False}),
                "timeout_sec": ("INT", {"default": 120, "min": 1, "max": 600, "step": 1}),
            },
            "optional": {
                "dry_run": ("BOOLEAN", {"default": False}),
            },
        }

    def call(self, endpoint=DEFAULT_ENDPOINT, action="health", params_json="{}",
             api_key_env=DEFAULT_AUTH_ENV, timeout_sec=120, dry_run=False, **_kwargs):
        try:
            params = _parse_payload_json(params_json, "params_json")
        except ValueError as exc:
            return "", f"error: {exc}"

        timeout_sec = C.clamp_int(timeout_sec, 1, 600, 120)
        if bool(dry_run):
            try:
                request, meta = _build_request(endpoint, action, params, api_key_env)
            except Exception as exc:
                return "", f"error: {exc}"
            preview = {
                "dry_run": True,
                "endpoint": request.full_url,
                "action": str(action),
                "params": params,
                "auth": bool(meta["has_token"]),
                "bytes": int(meta["bytes"]),
            }
            return (C.json_dumps(preview),
                    f"dry-run {action} {meta['bytes']}B auth={'yes' if meta['has_token'] else 'no'}")

        body, status = _post_json(endpoint, action, params, api_key_env, timeout_sec)
        return body, status


# ---------------------------------------------------------------------------
# 3) 节点包自描述清单
# ---------------------------------------------------------------------------
_NODE_META = {
    "DshDepthEstimate": {
        "display": "DSH 深度估计",
        "placeholder_keys": ["max_side", "device", "use_model"],
        "degrade": "无 transformers/本地模型 -> 亮度+Sobel 伪深度，info 里 method=fallback",
        "cost": "low-mid（长边先缩到 max_side）",
    },
    "DshNormalFromDepth": {
        "display": "DSH 法线(由深度)",
        "placeholder_keys": ["strength", "flip_green"],
        "degrade": "无（纯 numpy）",
        "cost": "low",
    },
    "DshAlphaMatte": {
        "display": "DSH 透明遮罩",
        "placeholder_keys": ["mode", "threshold", "edge_feather", "key_color", "tolerance"],
        "degrade": "无（纯 numpy）",
        "cost": "low",
    },
    "DshSeamlessTiling": {
        "display": "DSH 无缝贴图",
        "placeholder_keys": ["mode", "blend_px"],
        "degrade": "无（纯 numpy）",
        "cost": "low",
    },
    "DshAssetInspect": {
        "display": "DSH 素材体检",
        "placeholder_keys": ["max_side", "top_colors"],
        "degrade": "无（仅抽样统计）",
        "cost": "very-low",
    },
    "DshTemplateInject": {
        "display": "DSH 模板注入",
        "placeholder_keys": ["*"],  # 任意点路径
        "degrade": "无（纯 stdlib）",
        "cost": "very-low",
    },
    "DshDepthRefine": {
        "display": "DSH 深度精修",
        "placeholder_keys": ["radius", "eps", "smooth_radius", "flatten_foreground"],
        "degrade": "无（纯 numpy 导向滤波；无深度图时原样返回并说明）",
        "cost": "low（cumsum 实现 O(N)）",
    },
    "DshLayerSplit": {
        "display": "DSH 前背景剥离",
        "placeholder_keys": ["mode", "dilate", "feather", "plate_blur"],
        "degrade": "无（push-pull 金字塔回填，非生成式 inpaint）",
        "cost": "low",
    },
    "DshDepthModel": {
        "display": "DSH 真深度(DA2)",
        "placeholder_keys": ["max_side", "device", "invert", "normalize", "model_dir"],
        "degrade": "找不到 Depth Anything V2 本地权重 -> 直接抛错（绝不静默回退伪深度）",
        "cost": "mid（CUDA fp16，长边默认缩到 1024）",
    },
    "DshForgeBridgeCall": {
        "display": "DSH Forge 桥调用",
        "placeholder_keys": ["action", "params", "params.prompt", "params.width",
                             "params.height", "params.image"],
        "degrade": "HTTP 错误不抛异常，status=error: ...，body 原样返回",
        "cost": "network",
    },
    "DshWorkflowManifest": {
        "display": "DSH 工作流清单",
        "placeholder_keys": ["extra_json"],
        "degrade": "extra_json 非法时写入 extra_error 字段，不影响清单主体",
        "cost": "very-low",
    },
}

PREFERRED_PIPELINE = [
    "DshAssetInspect",
    "DshTemplateInject",
    "DshForgeBridgeCall",
    "DshAlphaMatte",
    "DshSeamlessTiling",
    "DshDepthEstimate",
    "DshNormalFromDepth",
]


def _node_classes():
    """收集本包所有以 Dsh 开头的节点类（assets / refine / depth_model + 本模块）。"""
    modules = []
    for mod_name in ("assets", "refine", "depth_model"):
        try:
            modules.append(__import__(f"{__package__}.{mod_name}", fromlist=[mod_name]))
        except Exception:
            try:
                modules.append(__import__(mod_name))  # 裸导入（测试环境）
            except Exception:
                pass

    found = {}
    here = sys.modules.get(__name__)
    for module in (*modules, here):
        if module is None:
            continue
        for name in dir(module):
            if not name.startswith("Dsh"):
                continue
            obj = getattr(module, name)
            if isinstance(obj, type) and hasattr(obj, "INPUT_TYPES"):
                found[name] = obj
    return found


def _input_summary(spec) -> list:
    out = []
    if not isinstance(spec, dict):
        return out
    for name, decl in spec.items():
        entry = {"name": str(name)}
        if isinstance(decl, (list, tuple)) and decl:
            head = decl[0]
            if isinstance(head, (list, tuple)):
                entry["type"] = "COMBO"
                entry["options"] = [str(v) for v in head]
            else:
                entry["type"] = str(head)
            if len(decl) > 1 and isinstance(decl[1], dict):
                for key in ("default", "min", "max"):
                    if key in decl[1] and not isinstance(decl[1][key], (list, tuple)):
                        entry[key] = decl[1][key]
        else:
            entry["type"] = "STRING"
        out.append(entry)
    return out


def build_manifest(extra=None) -> dict:
    """构建给前端 TS bridge 的节点契约清单（纯 JSON 可序列化）。"""
    classes = _node_classes()
    names = [n for n in PREFERRED_PIPELINE if n in classes]
    names += sorted(n for n in classes if n not in names)

    nodes = []
    for name in names:
        cls = classes[name]
        try:
            inputs = cls.INPUT_TYPES() or {}
        except Exception as exc:  # 单个节点自检失败不应毁掉整份清单
            nodes.append({"name": name, "error": f"{type(exc).__name__}: {exc}"})
            continue
        returns = [str(t) for t in getattr(cls, "RETURN_TYPES", ()) or ()]
        out_names = [str(n) for n in getattr(cls, "RETURN_NAMES", ()) or ()]
        outputs = []
        for i, rtype in enumerate(returns):
            outputs.append({
                "name": out_names[i] if i < len(out_names) else f"out{i}",
                "type": rtype,
            })
        meta = _NODE_META.get(name, {})
        doc = (cls.__doc__ or "").strip().splitlines()
        nodes.append({
            "name": name,
            "display": meta.get("display", name),
            "category": getattr(cls, "CATEGORY", ""),
            "function": getattr(cls, "FUNCTION", ""),
            "output_node": bool(getattr(cls, "OUTPUT_NODE", False)),
            "summary": doc[0].strip() if doc else "",
            "inputs": {
                "required": _input_summary(inputs.get("required", {})),
                "optional": _input_summary(inputs.get("optional", {})),
            },
            "outputs": outputs,
            "placeholder_keys": list(meta.get("placeholder_keys", [])),
            "degrade": meta.get("degrade", ""),
            "cost": meta.get("cost", ""),
        })

    manifest = {
        "pack": C.PACK_NAME,
        "version": C.PACK_VERSION,
        "categories": sorted({n.get("category", "") for n in nodes if n.get("category")}),
        "node_count": len(nodes),
        "nodes": nodes,
        "preferred_pipeline": [n for n in PREFERRED_PIPELINE if n in classes],
        "placeholder_syntax": {
            "value": "${a.b.c}",
            "fallback": "${a.b.missing:默认值}",
            "escape": "\\${原样保留}",
            "dot_path": "dict 按键 / list 用数字下标",
            "encoding": "字符串原样；true/false；数字 %.10g；对象/数组 -> 紧凑 JSON",
            "strict": "strict=true 时存在未解析占位符 -> ValueError（列出全部 key）",
        },
        "bridge": {
            "default_endpoint": DEFAULT_ENDPOINT,
            "actions": list(BRIDGE_ACTIONS),
            "auth_env": DEFAULT_AUTH_ENV,
            "request_shape": {"action": "<action>", "params": {"...": "..."}},
            "auth_header": "Authorization: Bearer <env value>（env 为空则不带）",
            "status_examples": ["200 ok", "error: HTTP 500 internal server error: ...",
                                "error: timeout after 120s"],
            "raises_on_http_error": False,
        },
        "media": {
            "image": "[B,H,W,C] float32 0..1（ComfyUI IMAGE 约定）",
            "mask": "[B,H,W] float32 0..1",
            "alpha_channel": 4,
            "note": "RGBA IMAGE 的第 4 通道即 alpha；部分内置节点只读前 3 通道，故同时输出 MASK",
        },
        "memory": {
            "gpu_vram_gb": 8,
            "ram_gb": 16,
            "rules": ["长边先缩到 max_side 再计算", "全程 float32", "深度模型缓存最多 1 份",
                      "不自动下载权重"],
        },
        "extra": extra if isinstance(extra, dict) else {},
    }
    return manifest


class DshWorkflowManifest:
    """输出本节点包的自描述清单（STRING JSON），供 TS bridge 通过 discovery 获取。

    输入
    ----
    extra_json : STRING（多行）JSON 对象；合法时并入清单 `extra` 字段，
                 非法时只在清单里写 `extra_error`，不影响主体。

    输出
    ----
    manifest_json : STRING，包含 pack/version、nodes（每个节点的
                    required/optional 输入、outputs 输出契约、placeholder_keys、
                    degrade 说明）、preferred_pipeline、placeholder_syntax、
                    bridge 约定、media 通道约定、memory 规则。
    """

    CATEGORY = "dsh/bridge"
    FUNCTION = "manifest"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("manifest_json",)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "extra_json": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {},
        }

    def manifest(self, extra_json="{}", **_kwargs):
        extra = {}
        error = ""
        raw = "" if extra_json is None else str(extra_json)
        if raw.strip():
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    extra = parsed
                else:
                    error = "extra_json 必须是 JSON 对象"
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
        data = build_manifest(extra=extra)
        if error:
            data["extra_error"] = error
        return (C.json_dumps(data, indent=2),)
