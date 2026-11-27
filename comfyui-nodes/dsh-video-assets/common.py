"""dsh-video-assets 公共工具层。

设计约束（8GB VRAM / 16GB RAM 的机器上必须成立）：
* 只依赖 ComfyUI venv 自带的 numpy / torch / Pillow，不新增依赖；
* 对 `folder_paths` / `comfy` 的 import 全部有保护 —— 缺 ComfyUI 时本包仍可 import，
  仅在实际执行需要它们的节点时才降级（并在 info 字符串里说明）；
* 中间计算一律 float32，禁止全分辨率 float64；
* 不保留无界缓存（深度模型缓存最多 1 份，见 assets.py）；
* 返回给 ComfyUI 的 IMAGE 为 `[B,H,W,C]` float32 0..1，MASK 为 `[B,H,W]` float32 0..1。
"""
from __future__ import annotations

import json
import math
import time

PACK_NAME = "dsh-video-assets"
PACK_VERSION = "0.1.0"

try:  # pragma: no cover - 取决于运行环境
    import numpy as np
except Exception:
    np = None

try:  # pragma: no cover
    import torch
except Exception:
    torch = None

try:  # pragma: no cover
    import folder_paths
except Exception:
    folder_paths = None

try:  # pragma: no cover
    import comfy  # noqa: F401
except Exception:
    comfy = None

# ComfyUI 的模型目录名（不同版本/不同 pack 叫法不一），仅用于“探测”，绝不下载
DEPTH_MODEL_DIR_HINTS = ("depth_anything", "depthanything", "depth", "depth_models")


# ---------------------------------------------------------------------------
# 能力探测
# ---------------------------------------------------------------------------
def has_numpy() -> bool:
    return np is not None


def has_torch() -> bool:
    return torch is not None


def has_tensor_stack() -> bool:
    """张量节点能否真正执行（numpy + torch 都在）。"""
    return np is not None and torch is not None


def require_numpy(where: str) -> None:
    if np is None:
        raise RuntimeError(
            f"{PACK_NAME}/{where}: 需要 numpy，但当前 Python 环境没有安装。"
            "请在 ComfyUI 的 venv 里运行本节点（ComfyUI 自带 numpy），或 pip install numpy。"
        )


def require_torch(where: str) -> None:
    if torch is None:
        raise RuntimeError(
            f"{PACK_NAME}/{where}: 需要 torch，但当前 Python 环境没有安装。"
            "本节点必须在 ComfyUI 的 Python 环境里执行。"
        )


# ---------------------------------------------------------------------------
# 张量 <-> numpy
# ---------------------------------------------------------------------------
def image_to_numpy(image, where: str = "node"):
    """ComfyUI IMAGE -> numpy `[B,H,W,C]` float32（0..1，连续内存）。

    兼容：torch.Tensor / numpy.ndarray；3 维输入按 `[H,W,C]` 或 `[B,H,W]` 启发式判定。
    """
    require_numpy(where)
    if image is None:
        raise ValueError(f"{PACK_NAME}/{where}: image 不能为空")

    if torch is not None and isinstance(image, torch.Tensor):
        arr = image.detach().to(device="cpu", dtype=torch.float32).numpy()
    else:
        arr = np.asarray(image, dtype=np.float32)

    if arr.ndim == 2:  # 单通道灰度
        arr = arr[None, :, :, None]
    elif arr.ndim == 3:
        if arr.shape[-1] in (1, 3, 4):  # [H,W,C] 单图
            arr = arr[None, ...]
        else:  # [B,H,W] 批量灰度
            arr = arr[..., None]
    if arr.ndim != 4:
        raise ValueError(
            f"{PACK_NAME}/{where}: 期望 IMAGE 为 [B,H,W,C]，实际 shape={tuple(arr.shape)}"
        )
    # float32 + 连续 + 截断，避免后续算子生成 float64 副本
    arr = np.ascontiguousarray(np.clip(arr, 0.0, 1.0), dtype=np.float32)
    return arr


def image_from_numpy(arr, where: str = "node"):
    """numpy `[B,H,W,C]` -> ComfyUI IMAGE 张量（float32）。通道数不裁剪（RGBA 合法）。"""
    require_torch(where)
    require_numpy(where)
    a = np.ascontiguousarray(np.asarray(arr, dtype=np.float32))
    if a.ndim == 3:
        a = a[None, ...]
    if a.ndim != 4:
        raise ValueError(f"{PACK_NAME}/{where}: 输出 IMAGE 期望 4 维，实际 {a.ndim} 维")
    return torch.from_numpy(a)


def mask_from_numpy(arr, where: str = "node"):
    """numpy `[B,H,W]`（或 `[B,H,W,1]`）-> ComfyUI MASK 张量。"""
    require_torch(where)
    require_numpy(where)
    a = np.asarray(arr, dtype=np.float32)
    if a.ndim == 4 and a.shape[-1] == 1:
        a = a[..., 0]
    if a.ndim == 2:
        a = a[None, ...]
    if a.ndim != 3:
        raise ValueError(f"{PACK_NAME}/{where}: 输出 MASK 期望 3 维，实际 {a.ndim} 维")
    return torch.from_numpy(np.ascontiguousarray(np.clip(a, 0.0, 1.0), dtype=np.float32))


# ---------------------------------------------------------------------------
# 设备 / 尺寸
# ---------------------------------------------------------------------------
def pick_device(pref: str = "auto"):
    """返回 (device, reason)。cuda 不可用时静默回落到 cpu（节点绝不因设备报错）。"""
    p = str(pref or "auto").strip().lower()
    if p == "cuda":
        if torch is not None and torch.cuda.is_available():
            return "cuda", "requested"
        return "cpu", "cuda-unavailable"
    if p == "auto":
        if torch is not None and torch.cuda.is_available():
            return "cuda", "auto"
        return "cpu", "auto-no-cuda"
    return "cpu", "requested-cpu"


def fit_max_side(h: int, w: int, max_side: int):
    """返回 (proc_h, proc_w, scale)。只缩小不放大 —— 8GB 卡的 OOM 防线。"""
    h, w = int(h), int(w)
    max_side = clamp_int(max_side, 64, 4096, 1024)
    longest = max(h, w, 1)
    if longest <= max_side:
        return h, w, 1.0
    scale = float(max_side) / float(longest)
    return max(4, int(round(h * scale))), max(4, int(round(w * scale))), scale


def resize_bhwc(arr, out_hw):
    """`[B,H,W,C]` float32 双线性缩放（torch，带 antialias；无 torch 时最近邻兜底）。"""
    require_numpy("resize")
    bh, bw = int(out_hw[0]), int(out_hw[1])
    if arr.shape[1] == bh and arr.shape[2] == bw:
        return arr
    if torch is None:
        yi = np.linspace(0, arr.shape[1] - 1, bh).astype(np.int64)
        xi = np.linspace(0, arr.shape[2] - 1, bw).astype(np.int64)
        return np.ascontiguousarray(arr[:, yi][:, :, xi], dtype=np.float32)
    t = torch.from_numpy(np.ascontiguousarray(arr, dtype=np.float32)).permute(0, 3, 1, 2)
    try:
        t = torch.nn.functional.interpolate(t, size=(bh, bw), mode="bilinear",
                                           align_corners=False, antialias=True)
    except TypeError:  # 老版本 torch 没有 antialias
        t = torch.nn.functional.interpolate(t, size=(bh, bw), mode="bilinear",
                                           align_corners=False)
    out = t.permute(0, 2, 3, 1).contiguous().numpy()
    del t
    return out.astype(np.float32, copy=False)


def clamp_int(value, low: int, high: int, default: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        v = int(default)
    return max(int(low), min(int(high), v))


def clamp_float(value, low: float, high: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = float(default)
    if not math.isfinite(v):
        v = float(default)
    return max(float(low), min(float(high), v))


def empty_cache(device: str = None) -> None:
    """尽力释放显存；失败无所谓（永远不抛）。"""
    if torch is not None and (device is None or device == "cuda"):
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    if comfy is not None:
        try:
            import importlib

            mm = getattr(comfy, "model_management", None)
            if mm is None:  # `import comfy` 不会自动带入子模块，按需显式导入
                mm = importlib.import_module("comfy.model_management")
            fn = getattr(mm, "soft_empty_cache", None)
            if callable(fn):
                fn()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 数学小工具（全部 float32）
# ---------------------------------------------------------------------------
def luma_of(rgb):
    """`[...,3]` -> `[...]` 亮度（BT.601），float32。"""
    require_numpy("luma")
    return (rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114).astype(np.float32)


def robust_norm(a):
    """2%/98% 分位拉伸到 0..1；平坦图返回全 0，绝不产生 NaN。"""
    require_numpy("robust_norm")
    a = np.asarray(a, dtype=np.float32)
    if a.size == 0:
        return a
    lo = float(np.percentile(a, 2.0))
    hi = float(np.percentile(a, 98.0))
    if hi - lo < 1e-6:
        lo = float(np.min(a))
        hi = float(np.max(a))
    if hi - lo < 1e-6:
        return np.zeros_like(a, dtype=np.float32)
    return np.clip((a - lo) / (hi - lo), 0.0, 1.0).astype(np.float32, copy=False)


def sobel_grad(a):
    """2D 数组 -> (gx, gy) float32。边缘复制填充，输出 shape 与输入一致。"""
    require_numpy("sobel")
    if a.ndim != 2:
        raise ValueError("sobel_grad 需要 2D 数组")
    p = np.pad(np.asarray(a, dtype=np.float32), ((1, 1), (1, 1)), mode="edge")
    gx = (p[:-2, 2:] + 2.0 * p[1:-1, 2:] + p[2:, 2:]) - \
         (p[:-2, :-2] + 2.0 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2.0 * p[2:, 1:-1] + p[2:, 2:]) - \
         (p[:-2, :-2] + 2.0 * p[:-2, 1:-1] + p[:-2, 2:])
    return gx.astype(np.float32, copy=False), gy.astype(np.float32, copy=False)


def _box_blur_once(x, k):
    """`[B,H,W]` 单次盒式模糊（累积和实现，O(HW)）。"""
    pad = k // 2
    if pad < 1:
        return x
    xp = np.pad(np.asarray(x, dtype=np.float32), ((0, 0), (pad, pad), (pad, pad)), mode="edge")
    cs = np.cumsum(xp, axis=2, dtype=np.float32)
    cs = np.concatenate([np.zeros_like(cs[:, :, :1]), cs], axis=2)
    xh = (cs[:, :, k:] - cs[:, :, :-k]) / float(k)
    cs = np.cumsum(xh, axis=1, dtype=np.float32)
    cs = np.concatenate([np.zeros_like(cs[:, :1, :]), cs], axis=1)
    out = (cs[:, k:, :] - cs[:, :-k, :]) / float(k)
    return out.astype(np.float32, copy=False)


def box_blur(x, k, passes: int = 2):
    """`[B,H,W]` 盒式模糊（k 自动取奇数；passes 次 ≈ 高斯）。k<=1 时原样返回。"""
    require_numpy("blur")
    k = int(k)
    if k <= 1:
        return np.asarray(x, dtype=np.float32)
    if k % 2 == 0:
        k += 1
    out = np.asarray(x, dtype=np.float32)
    for _ in range(max(1, int(passes))):
        out = _box_blur_once(out, k)
    return out


def parse_hex_color(text, default=(0.0, 1.0, 0.0)):
    """`#RRGGBB` / `RRGGBB` / `r,g,b`(0..255) / `r,g,b`(0..1) -> (r,g,b) float32 0..1。"""
    require_numpy("color")
    s = str(text or "").strip()
    try:
        if s.startswith("#"):
            s = s[1:]
        if "," in s:
            parts = [float(p) for p in s.split(",")[:3]]
            if len(parts) != 3:
                raise ValueError("need 3 components")
            if max(parts) > 1.0:
                parts = [p / 255.0 for p in parts]
            return tuple(max(0.0, min(1.0, p)) for p in parts)
        if len(s) == 6:
            return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        if len(s) == 3:
            return tuple(int(c * 2, 16) / 255.0 for c in s)
    except Exception:
        pass
    return tuple(float(c) for c in default)


# ---------------------------------------------------------------------------
# 字符串 / JSON
# ---------------------------------------------------------------------------
def json_dumps(obj, indent=None):
    return json.dumps(obj, ensure_ascii=False, indent=indent, default=_json_default)


def _json_default(o):
    try:
        if np is not None and isinstance(o, np.generic):
            return o.item()
        if np is not None and isinstance(o, np.ndarray):
            return o.tolist()
        if torch is not None and isinstance(o, torch.Tensor):
            return o.detach().cpu().tolist()
    except Exception:
        pass
    return repr(o)


def info_string(kind: str, **pairs) -> str:
    """构造一行稳定的 info 文本，例如：

    `dsh-depth method=fallback reason=no-local-model device=cpu proc=512x768 ...`
    """
    parts = [f"dsh-{kind}", f"v={PACK_VERSION}"]
    for key, value in pairs.items():
        text = str(value)
        if " " in text or "\n" in text:
            text = text.replace("\n", "_").replace(" ", "_")
        parts.append(f"{key}={text}")
    return " ".join(parts)


def elapsed_ms(t0: float) -> int:
    return int(round((time.perf_counter() - t0) * 1000.0))
