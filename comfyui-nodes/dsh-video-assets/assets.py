"""dsh-video-assets —— 轻量素材处理节点（A 类）。

节点：DshDepthEstimate / DshNormalFromDepth / DshAlphaMatte / DshSeamlessTiling / DshAssetInspect

共同纪律：
* 纯 numpy/torch 实现，**不自动下载任何权重**；
* 可选模型缺失时走文档化的 cheap fallback，并在返回的 info 字符串里写明；
* 先把长边缩到 max_side 再计算，再放大回原尺寸 —— 8GB VRAM 的 OOM 防线；
* 中间结果 float32，循环内 del 释放。
"""
from __future__ import annotations

import os
import time

try:  # 作为包的一部分被 import（ComfyUI 的加载方式）
    from . import common as C
except ImportError:  # 兼底：被当作顶层模块加载时（少数加载器/手测）
    import common as C  # type: ignore


# ---------------------------------------------------------------------------
# 深度模型（可选）：只做“探测 + 离线加载”，绝不下载
# ---------------------------------------------------------------------------
_DEPTH_CACHE = {}  # {"pipe": ((path, device), pipe)}，最多 1 项，防止 8GB 卡被多模型挤爆


def _probe_local_depth_model() -> str:
    """在 ComfyUI 的模型目录里找可离线加载的 depth-estimation 模型目录。

    判据：目录里同时有 `config.json` 和权重文件（HF transformers 布局）。
    找不到返回 ""，调用方据此降级。
    """
    roots = []
    fp = C.folder_paths
    if fp is not None:
        for name in C.DEPTH_MODEL_DIR_HINTS:
            try:
                roots.extend(list(fp.get_folder_paths(name) or ()))
            except Exception:
                continue
        try:
            base = getattr(fp, "models_dir", "") or ""
            if base:
                roots.append(os.path.join(base, "depth_anything"))
                roots.append(os.path.join(base, "depthanything"))
        except Exception:
            pass
    seen = set()
    weight_ext = (".safetensors", ".bin", ".pth", ".pt")
    for root in roots:
        if not root or root in seen:
            continue
        seen.add(root)
        try:
            if not os.path.isdir(root):
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                if dirpath.count(os.sep) - root.count(os.sep) > 3:
                    dirnames[:] = []
                    continue
                if "config.json" in filenames and any(
                        f.lower().endswith(weight_ext) for f in filenames):
                    return dirpath
        except Exception:
            continue
    return ""


def _load_depth_pipe(path: str, device: str):
    """用 transformers 的 depth-estimation pipeline 离线加载本地模型。

    `local_files_only=True` 是关键：即使路径不存在也不会联网下载。
    """
    key = (os.path.abspath(path), device)
    hit = _DEPTH_CACHE.get("pipe")
    if hit and hit[0] == key:
        return hit[1]
    _DEPTH_CACHE.clear()  # 只保留 1 份，避免显存/内存累积
    from transformers import pipeline  # 延迟导入：未安装 -> ImportError -> 降级

    dev_arg = 0 if device == "cuda" else -1
    pipe = pipeline("depth-estimation", model=path, device=dev_arg, local_files_only=True)
    _DEPTH_CACHE["pipe"] = (key, pipe)
    return pipe


def _depth_from_model(pipe, rgb01):
    """用 pipeline 跑一张图，返回 `[h,w]` float32 0..1。"""
    np = C.np
    from PIL import Image

    u8 = (np.clip(rgb01, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    result = pipe(Image.fromarray(u8))
    depth = None
    if isinstance(result, dict):
        depth = result.get("depth")
        if depth is None:
            depth = result.get("predicted_depth")
    else:
        depth = result
    if isinstance(depth, Image.Image):
        arr = np.asarray(depth, dtype=np.float32) / 255.0
    else:
        arr = np.asarray(depth, dtype=np.float32)
        if arr.ndim == 3 and arr.shape[0] == 1:
            arr = arr[0]
        arr = C.robust_norm(arr)
    return arr.astype(np.float32, copy=False)


def _pseudo_depth(rgb01):
    """cheap fallback：亮度 + Sobel 梯度幅值合成的伪深度（白=近）。

    这是文档化的降级方案，适合产品图/人像这类“亮部靠前”的素材，
    不是真实几何深度；需要真深度请装 transformers 并放好本地模型。
    """
    np = C.np
    luma = C.luma_of(rgb01)
    luma = C.robust_norm(luma)
    luma_s = C.box_blur(luma[None, :, :], 5, passes=1)[0]
    gx, gy = C.sobel_grad(luma)
    grad = C.robust_norm(np.sqrt(gx * gx + gy * gy))
    grad_s = C.box_blur(grad[None, :, :], 3, passes=1)[0]
    mixed = 0.72 * luma_s + 0.28 * grad_s
    return C.robust_norm(mixed)


# ---------------------------------------------------------------------------
# 1) 深度估计
# ---------------------------------------------------------------------------
class DshDepthEstimate:
    """深度图估计（IMAGE 批 -> 灰度深度 IMAGE + info STRING）。

    输入
    ----
    image      : IMAGE  [B,H,W,C]（C>=3，取前 3 通道）
    device     : auto / cpu / cuda（cuda 不可用自动回落 cpu）
    max_side   : 处理时长边上限（默认 1024，范围 256..2048）。
                 **永远先缩小到 max_side 处理，再双线性放大回原尺寸**，8GB 卡不会 OOM。
    use_model  : 可选，默认 False。True 时尝试用本机已存在的 depth 模型（离线加载），
                 失败则自动降级。
    model_path : 可选，显式指定本地 HF 模型目录；留空则自动探测 ComfyUI 模型目录。

    输出
    ----
    depth : IMAGE [B,H,W,3] 灰度三分量复制（0..1，白=近）
    info  : STRING，形如 `dsh-depth method=fallback reason=no-local-model device=cpu ...`

    降级行为
    --------
    没有 transformers / 没有本地模型 / 加载失败 -> 使用亮度+Sobel 梯度伪深度，
    并在 info 里给出 `method=fallback` 与原因；**绝不会联网下载权重**。
    """

    CATEGORY = "dsh/video-assets"
    FUNCTION = "estimate"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("depth", "info")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "device": (["auto", "cpu", "cuda"], {"default": "auto"}),
                "max_side": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32}),
            },
            "optional": {
                "use_model": ("BOOLEAN", {"default": False}),
                "model_path": ("STRING", {"default": "", "multiline": False}),
            },
        }

    def estimate(self, image, device="auto", max_side=1024,
                 use_model=False, model_path="", **_kwargs):
        np = C.np
        C.require_numpy("DshDepthEstimate")
        C.require_torch("DshDepthEstimate")
        t0 = time.perf_counter()

        arr = C.image_to_numpy(image, "DshDepthEstimate")
        b, h, w, _ch = arr.shape
        max_side = C.clamp_int(max_side, 256, 2048, 1024)
        proc_h, proc_w, scale = C.fit_max_side(h, w, max_side)
        dev, dev_reason = C.pick_device(device)

        pipe = None
        method = "fallback"
        reason = "no-model"
        if bool(use_model):
            path = str(model_path or "").strip() or _probe_local_depth_model()
            if not path:
                reason = "no-local-model"
            elif not os.path.exists(path):
                reason = "model-path-missing"
            else:
                try:
                    pipe = _load_depth_pipe(path, dev)
                    method = "model"
                    reason = "ok"
                except Exception as exc:  # ImportError / 权重不兼容 / OOM ...
                    reason = "load-failed:" + type(exc).__name__
                    pipe = None
                    C.empty_cache(dev)

        outs = []
        for i in range(b):
            if scale < 1.0:
                work = C.resize_bhwc(arr[i:i + 1], (proc_h, proc_w))[0]
            else:
                work = arr[i]
            rgb = work[..., :3]
            if rgb.shape[2] == 1:
                rgb = np.repeat(rgb, 3, axis=2)
            try:
                depth = _depth_from_model(pipe, rgb) if pipe is not None else _pseudo_depth(rgb)
            except Exception as exc:  # 模型中途失败：单张降级，不炸整个工作流
                method = "fallback"
                reason = "run-failed:" + type(exc).__name__
                pipe = None
                depth = _pseudo_depth(rgb)
            if depth.shape[:2] != (proc_h, proc_w):
                depth = C.resize_bhwc(depth[None, :, :, None], (proc_h, proc_w))[0, :, :, 0]
            depth = C.robust_norm(depth)
            back = C.resize_bhwc(depth[None, :, :, None], (h, w))[0, :, :, 0]
            outs.append(np.repeat(back[:, :, None], 3, axis=2).astype(np.float32))
            del work, rgb, depth, back

        out = np.stack(outs, axis=0).astype(np.float32, copy=False)
        del arr, outs
        C.empty_cache(dev)
        info = C.info_string(
            "depth", method=method, reason=reason, device=dev, dev_reason=dev_reason,
            proc=f"{proc_w}x{proc_h}", orig=f"{w}x{h}", batch=b,
            ms=C.elapsed_ms(t0),
        )
        return (C.image_from_numpy(out, "DshDepthEstimate"), info)


# ---------------------------------------------------------------------------
# 2) 深度 -> 法线
# ---------------------------------------------------------------------------
class DshNormalFromDepth:
    """深度 IMAGE -> 切线空间法线 IMAGE（纯 numpy，无模型）。

    输入
    ----
    depth       : IMAGE（任取亮度/灰度；白=近）
    strength    : FLOAT 0..8，梯度强度（越大细节越硬，默认 1.5）
    flip_green  : BOOLEAN，翻转 Y 分量（DirectX / OpenGL 的绿通道约定差异）
    invert_depth: 可选 BOOLEAN，反相深度（用于“黑=近”的图）

    输出
    ----
    normal : IMAGE [B,H,W,3]，编码为 `n*0.5+0.5`（0.5,0.5,1 表示朝前）
    """

    CATEGORY = "dsh/video-assets"
    FUNCTION = "compute"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("normal",)
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("IMAGE",),
                "strength": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 8.0, "step": 0.05}),
                "flip_green": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "invert_depth": ("BOOLEAN", {"default": False}),
            },
        }

    def compute(self, depth, strength=1.5, flip_green=False, invert_depth=False, **_kwargs):
        np = C.np
        C.require_numpy("DshNormalFromDepth")
        C.require_torch("DshNormalFromDepth")

        arr = C.image_to_numpy(depth, "DshNormalFromDepth")
        b, h, w, _ch = arr.shape
        s = C.clamp_float(strength, 0.0, 8.0, 1.5)
        out = np.empty((b, h, w, 3), dtype=np.float32)
        for i in range(b):
            # 灰度图的三通道相同，luma 结果就是通道值本身，无需分支
            d = C.luma_of(arr[i]) if arr.shape[3] >= 3 else arr[i, :, :, 0]
            if bool(invert_depth):
                d = 1.0 - d
            gx, gy = C.sobel_grad(d)
            nx = -gx * (s * 0.125)
            ny = -gy * (s * 0.125)
            if bool(flip_green):
                ny = -ny
            nz = np.ones_like(nx)
            length = np.sqrt(nx * nx + ny * ny + nz * nz)
            length = np.maximum(length, 1e-6)
            out[i, :, :, 0] = np.clip(nx / length * 0.5 + 0.5, 0.0, 1.0)
            out[i, :, :, 1] = np.clip(ny / length * 0.5 + 0.5, 0.0, 1.0)
            out[i, :, :, 2] = np.clip(nz / length * 0.5 + 0.5, 0.0, 1.0)
            del d, gx, gy, nx, ny, nz, length
        del arr
        return (C.image_from_numpy(out, "DshNormalFromDepth"),)


# ---------------------------------------------------------------------------
# 3) 透明遮罩 / 抠图
# ---------------------------------------------------------------------------
class DshAlphaMatte:
    """生成 alpha 遮罩：IMAGE -> RGBA IMAGE + MASK。

    输入
    ----
    image       : IMAGE [B,H,W,C]（已有 4 通道时，原 alpha 会与结果相乘）
    mode        : luma_key | chroma_key | threshold
    threshold   : FLOAT 0..1 亮度阈值（luma_key / threshold 用）
    edge_feather: INT 0..64，对 alpha 做盒式模糊（≈高斯）软化边缘；0 = 关闭
    key_color   : 可选，chroma_key 的目标色，`#00FF00` 或 `0,255,0`
    tolerance   : 可选，chroma_key 容差（0..1 的 RGB 空间归一化距离）
    softness    : 可选，过渡带宽度（0..1），0 时是硬边
    invert      : 可选，反相

    输出
    ----
    rgba : IMAGE [B,H,W,**4**]  —— 第 4 通道即 alpha（ComfyUI 允许任意通道数的 IMAGE；
           SaveImage/PreviewImage 能写出 PNG 透明度；**部分内置节点只读前 3 通道**，
           所以同时提供 MASK 供遮罩用途）
    mask : MASK  [B,H,W]
    """

    CATEGORY = "dsh/video-assets"
    FUNCTION = "matte"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("rgba", "mask")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mode": (["luma_key", "chroma_key", "threshold"], {"default": "luma_key"}),
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "edge_feather": ("INT", {"default": 0, "min": 0, "max": 64, "step": 1}),
            },
            "optional": {
                "key_color": ("STRING", {"default": "#00FF00", "multiline": False}),
                "tolerance": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01}),
                "softness": ("FLOAT", {"default": 0.05, "min": 0.0, "max": 1.0, "step": 0.01}),
                "invert": ("BOOLEAN", {"default": False}),
            },
        }

    def matte(self, image, mode="luma_key", threshold=0.5, edge_feather=0,
              key_color="#00FF00", tolerance=0.15, softness=0.05, invert=False, **_kwargs):
        np = C.np
        C.require_numpy("DshAlphaMatte")
        C.require_torch("DshAlphaMatte")

        arr = C.image_to_numpy(image, "DshAlphaMatte")
        b, h, w, ch = arr.shape
        rgb = arr[..., :3]
        if rgb.shape[3] == 1:
            rgb = np.repeat(rgb, 3, axis=3)
        elif rgb.shape[3] == 2:
            rgb = np.concatenate([rgb, rgb[..., :1]], axis=3)[..., :3]
        base_alpha = arr[..., 3] if ch >= 4 else np.ones((b, h, w), dtype=np.float32)

        t = C.clamp_float(threshold, 0.0, 1.0, 0.5)
        s = C.clamp_float(softness, 0.0, 1.0, 0.05)
        mode = str(mode or "luma_key").strip().lower()

        if mode == "chroma_key":
            key = np.asarray(C.parse_hex_color(key_color), dtype=np.float32)
            tol = C.clamp_float(tolerance, 0.0, 1.0, 0.15)
            dist = np.sqrt(np.mean((rgb - key.reshape(1, 1, 1, 3)) ** 2, axis=3))  # 0..~1
            if s <= 1e-4:
                alpha = (dist > tol).astype(np.float32)
            else:
                x = np.clip((dist - (tol - s)) / (2.0 * s), 0.0, 1.0)
                alpha = (x * x * (3.0 - 2.0 * x)).astype(np.float32)
            del dist
        else:
            luma = C.luma_of(rgb)
            if mode == "threshold":
                if s <= 1e-4:
                    alpha = (luma >= t).astype(np.float32)
                else:
                    x = np.clip((luma - (t - s)) / (2.0 * s), 0.0, 1.0)
                    alpha = (x * x * (3.0 - 2.0 * x)).astype(np.float32)
            else:  # luma_key（默认）
                if s <= 1e-4:
                    alpha = (luma >= t).astype(np.float32)
                else:
                    x = np.clip((luma - (t - s)) / (2.0 * s), 0.0, 1.0)
                    alpha = (x * x * (3.0 - 2.0 * x)).astype(np.float32)
            del luma

        if bool(invert):
            alpha = 1.0 - alpha
        alpha = np.clip(alpha * base_alpha, 0.0, 1.0).astype(np.float32)

        feather = C.clamp_int(edge_feather, 0, 64, 0)
        if feather > 0:
            alpha = C.box_blur(alpha, feather * 2 + 1, passes=2)

        rgba = np.concatenate([rgb, alpha[..., None]], axis=3).astype(np.float32, copy=False)
        mask = np.ascontiguousarray(alpha, dtype=np.float32)
        del arr, rgb, base_alpha
        return (C.image_from_numpy(rgba, "DshAlphaMatte"),
                C.mask_from_numpy(mask, "DshAlphaMatte"))


# ---------------------------------------------------------------------------
# 4) 无缝贴图
# ---------------------------------------------------------------------------
def _seam_edge_equalize(a, axis: int, k: int):
    """`edge_blend`：把两条对边在 k 像素内渐变到同一个均值，使 wrap 接缝为 0。

    做法：delta = (A_outer - B_outer)/2，A 减去、B 加上随距离衰减的 delta，
    于是 out[0] 与 out[-1] 严格相等（C0 连续），修正只在边缘带内生效。
    """
    np = C.np
    n = a.shape[axis]
    k = int(min(max(0, k), max(0, n // 2)))
    if k < 1:
        return a
    b = np.moveaxis(a, axis, 0)
    head = b[:k].copy()
    tail = b[n - k:].copy()
    ramp = (1.0 - np.arange(k, dtype=np.float32) / float(k))
    rshape = (k,) + (1,) * (b.ndim - 1)
    ramp = ramp.reshape(rshape)
    delta = 0.5 * (head[:1] - tail[-1:])  # [1, ...]，标量场
    b[:k] = head - delta * ramp
    b[n - k:] = tail + delta * ramp[::-1]
    # 注意：moveaxis 的逆变换是 moveaxis(b, 0, axis)，不是再次 (axis, 0)
    return np.moveaxis(b, 0, axis)


def _seam_mirror_heal(a, axis: int, k: int):
    """`wrap_blend`：以镜像均值修补中线接缝（half-offset 后接缝落在画面中央）。

    在接缝线两侧宽 k 的带内，把像素向“镜像均值”混合；接缝两侧权重都到 1，
    于是 out[c-1] == out[c] 严格成立 —— 接缝被抹平，带外保持原样。
    """
    np = C.np
    n = a.shape[axis]
    if k < 1 or n < 4:
        return a
    c = n // 2
    k = int(min(k, c))
    idx = np.arange(n)
    src = np.clip(2 * c - 1 - idx, 0, n - 1)          # 关于 x=c-0.5 镜像
    mirrored = np.take(a, src, axis=axis)
    dist = np.abs(idx.astype(np.float32) - (c - 0.5))  # 到轴心的距离
    weight = np.clip(1.0 - np.maximum(dist - 0.5, 0.0) / float(k), 0.0, 1.0)
    wshape = [1] * a.ndim
    wshape[axis] = n
    weight = weight.reshape(wshape).astype(np.float32)
    out = a + weight * (0.5 * (mirrored - a))
    return out.astype(np.float32, copy=False)


def _fit_hw(a, h: int, w: int):
    """裁/补到精确的 h,w（mirror 模式拼接后可能有 1 像素误差）。"""
    np = C.np
    a = a[:, :h, :w, :]
    ph = max(0, h - a.shape[1])
    pw = max(0, w - a.shape[2])
    if ph or pw:
        a = np.pad(a, ((0, 0), (0, ph), (0, pw), (0, 0)), mode="edge")
    return a


class DshSeamlessTiling:
    """把纹理变成可无缝平铺（纯 numpy，无模型）。

    输入
    ----
    image    : IMAGE [B,H,W,C]
    mode     : mirror（镜像四分拼接，接缝严格为 0，但只保留 1/4 内容）
               wrap_blend（half-offset 后镜像均值修补中线接缝，保留全部细节，推荐）
               edge_blend（只把对边渐变到均值，接缝严格为 0，边缘轻微拉伸）
    blend_px : INT 0..512 混合带宽（像素）；0 表示该模式不混合

    输出
    ----
    image : IMAGE，尺寸不变。注意：做成可平铺后会损失原图边缘的独立性。
    """

    CATEGORY = "dsh/video-assets"
    FUNCTION = "make"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mode": (["wrap_blend", "mirror", "edge_blend"], {"default": "wrap_blend"}),
                "blend_px": ("INT", {"default": 64, "min": 0, "max": 512, "step": 8}),
            },
            "optional": {},
        }

    def make(self, image, mode="wrap_blend", blend_px=64, **_kwargs):
        np = C.np
        C.require_numpy("DshSeamlessTiling")
        C.require_torch("DshSeamlessTiling")

        arr = C.image_to_numpy(image, "DshSeamlessTiling")
        b, h, w, _ch = arr.shape
        k = C.clamp_int(blend_px, 0, 512, 64)
        mode = str(mode or "wrap_blend").strip().lower()
        outs = []
        for i in range(b):
            img = arr[i]
            if mode == "mirror":
                qh, qw = max(1, h // 2), max(1, w // 2)
                quad = img[:qh, :qw, :]
                top = np.concatenate([quad, quad[:, ::-1, :]], axis=1)
                full = np.concatenate([top, top[::-1, :, :]], axis=0)
                out = _fit_hw(full[None, ...], h, w)[0]
                del quad, top, full
            elif mode == "edge_blend":
                # img 是单张 (H, W, C)：空间轴是 1(W) 和 0(H)，不是 1/2
                out = _seam_edge_equalize(img, 1, k)
                out = _seam_edge_equalize(out, 0, k)
            else:  # wrap_blend
                rolled = np.roll(img, (h // 2, w // 2), axis=(0, 1))
                healed = _seam_mirror_heal(rolled, 1, k)
                healed = _seam_mirror_heal(healed, 0, k)
                out = healed
                del rolled
            outs.append(np.ascontiguousarray(np.clip(out, 0.0, 1.0), dtype=np.float32))
            del img, out
        result = np.stack(outs, axis=0)
        del arr, outs
        return (C.image_from_numpy(result, "DshSeamlessTiling"),)


# ---------------------------------------------------------------------------
# 5) 素材体检
# ---------------------------------------------------------------------------
class DshAssetInspect:
    """廉价元数据体检：只输出 STRING JSON，给前端判断“值不值得跑重节点”。

    输入
    ----
    image      : IMAGE
    max_side   : INT 采样长边上限（默认 256，范围 32..1024）——按步长抽样，不做全图运算
    top_colors : INT 主色数量（默认 5，1..16），用 4bit/通道量化统计，不是 KMeans

    输出
    ----
    json : STRING，字段：width/height/batch/channels/has_alpha/is_opaque/
           is_grayscale/mean/std/dominant_colors(+ratio)/aspect/colorful/采样信息
    """

    CATEGORY = "dsh/video-assets"
    FUNCTION = "inspect"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("json",)
    OUTPUT_NODE = True  # 只输出字符串，没有视觉输出

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "max_side": ("INT", {"default": 256, "min": 32, "max": 1024, "step": 32}),
                "top_colors": ("INT", {"default": 5, "min": 1, "max": 16, "step": 1}),
            },
            "optional": {},
        }

    def inspect(self, image, max_side=256, top_colors=5, **_kwargs):
        np = C.np
        C.require_numpy("DshAssetInspect")
        C.require_torch("DshAssetInspect")

        arr = C.image_to_numpy(image, "DshAssetInspect")
        b, h, w, ch = arr.shape
        max_side = C.clamp_int(max_side, 32, 1024, 256)
        top_n = C.clamp_int(top_colors, 1, 16, 5)

        sh = max(1, int(np.ceil(h / float(max_side))))
        sw = max(1, int(np.ceil(w / float(max_side))))
        sub = arr[:, ::sh, ::sw, :]
        rgb = sub[..., :3]
        if rgb.shape[3] < 3:
            rgb = np.repeat(rgb[..., :1], 3, axis=3)
        alpha = sub[..., 3] if ch >= 4 else None

        mean = [float(v) for v in rgb.reshape(-1, 3).mean(axis=0)]
        std = [float(v) for v in rgb.reshape(-1, 3).std(axis=0)]

        flat = rgb.reshape(-1, 3)
        q = np.clip((flat * 15.0 + 0.5).astype(np.int32), 0, 15)
        keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
        uniq, counts = np.unique(keys, return_counts=True)
        order = np.argsort(-counts)[:top_n]
        total = float(keys.size) or 1.0
        dominant = []
        for oi in order:
            key = int(uniq[oi])
            r15, g15, b15 = (key // 256) % 16, (key // 16) % 16, key % 16
            hex_rgb = "#%02X%02X%02X" % (
                int(round(r15 / 15.0 * 255.0)),
                int(round(g15 / 15.0 * 255.0)),
                int(round(b15 / 15.0 * 255.0)),
            )
            dominant.append({"hex": hex_rgb, "ratio": round(float(counts[oi]) / total, 4)})

        is_opaque = True
        alpha_min = 1.0
        if alpha is not None:
            alpha_min = float(alpha.min())
            is_opaque = bool(alpha_min >= 0.999)

        gray = bool(float(np.abs(rgb[..., 0] - rgb[..., 1]).mean()) < 0.01
                    and float(np.abs(rgb[..., 1] - rgb[..., 2]).mean()) < 0.01)
        color_std = float(np.max(std)) if std else 0.0

        report = {
            "pack": C.PACK_NAME,
            "version": C.PACK_VERSION,
            "width": int(w),
            "height": int(h),
            "batch": int(b),
            "channels": int(ch),
            "has_alpha": bool(ch >= 4),
            "alpha_min": round(float(alpha_min), 4),
            "is_opaque": is_opaque,
            "is_grayscale": gray,
            "mean": [round(v, 4) for v in mean],
            "std": [round(v, 4) for v in std],
            "color_std": round(color_std, 4),
            "aspect": round(float(w) / float(max(1, h)), 4),
            "dominant_colors": dominant,
            "sample": {"step": int(max(sh, sw)), "pixels": int(flat.shape[0]),
                       "max_side": int(max_side)},
            "pixels_total": int(w) * int(h) * int(b),
        }
        del arr, sub, rgb, flat, q, keys
        return (C.json_dumps(report),)
