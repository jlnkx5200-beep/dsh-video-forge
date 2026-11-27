"""dsh-video-assets —— 画质精修节点（A2 类）。

节点：DshDepthRefine / DshLayerSplit

为什么需要这两个节点（对应 docs/visual-quality-standard.md 的画质红线）：

* **深度图不能直接拿去做大振幅顶点位移**。单目深度模型（DA3 / Depth Anything 系列）
  输出的是「块状平滑 + 边缘略糊」的相对深度，直接位移会在前景边缘拉出锯齿和撕裂。
  `DshDepthRefine` 用 **导向滤波（guided filter，He et al.）** 把深度边缘对齐到
  原图边缘，再做强边缘保持的平滑，最后可选地压平（flatten）前景主体，避免前景被
  「拉走」时把背景像素一起拽起来。
* **前景语义剥离**需要一张「背景板」：主体被抹掉、且洞里是**周围像素延展**而不是黑色。
  `DshLayerSplit` 用 push-pull 金字塔（带掩码的逐级降采样均值 + 上采样回填）把洞填掉，
  这是确定性的、无幻觉的修复方式，比生成式 inpaint 更适合 2.5D 合成。

共同纪律：纯 numpy / torch，不下载权重、不依赖 scipy，8GB 显存友好。
"""
from __future__ import annotations

try:  # 作为包的一部分被 import（ComfyUI 的加载方式）
    from . import common as C
except ImportError:  # 兼底：被当作顶层模块导入时
    import common as C  # type: ignore

np = C.np
torch = C.torch


# ---------------------------------------------------------------------------
# numpy 实现的小工具（全部用 cumsum，避免 scipy 依赖）
# ---------------------------------------------------------------------------
def _box_sum(a, r):
    """半径 r 的方框求和（边界复制填充），O(N)。

    实现说明（曾出过一次尺寸 off-by-one 的 bug）：先 edge padding r 圈，得到 N+2r = N+k-1，
    再做「左上角前缀和」c（尺寸 (N+k)²，第 0 行/列是 0），最后四角相减得到严格的 N×N。
    """
    arr = a.astype(np.float64)
    if r <= 0:
        return arr
    k = 2 * r + 1
    p = np.pad(arr, [(r, r), (r, r)], mode="edge")
    h, w = p.shape
    c = np.zeros((h + 1, w + 1), dtype=np.float64)
    c[1:, 1:] = p.cumsum(0).cumsum(1)
    out = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    assert out.shape == arr.shape, f"_box_sum 尺寸错误：{out.shape} vs {arr.shape}"
    return out


def _box_mean(a, r):
    return _box_sum(a, r) / float((2 * r + 1) ** 2)


def _guided_filter(guide, src, r, eps):
    """单通道导向滤波：把 src 的边缘对齐到 guide。"""
    if guide.shape != src.shape:
        h = min(guide.shape[0], src.shape[0])
        w = min(guide.shape[1], src.shape[1])
        guide = guide[:h, :w]
        src = src[:h, :w]
    mean_i = _box_mean(guide, r)
    mean_p = _box_mean(src, r)
    corr_i = _box_mean(guide * guide, r)
    corr_ip = _box_mean(guide * src, r)
    var_i = corr_i - mean_i * mean_i
    cov_ip = corr_ip - mean_i * mean_p
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    mean_a = _box_mean(a, r)
    mean_b = _box_mean(b, r)
    return mean_a * guide + mean_b


def _luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def _normalize(d, mode, stretch=0.02):
    """归一化。min_max 用 2%/98% 分位拉伸，避免单个极端像素把整张灰掉。"""
    d = d.astype(np.float32)
    lo, hi = float(np.min(d)), float(np.max(d))
    if hi - lo < 1e-6:
        return np.zeros_like(d)
    if mode == "min_max":
        if stretch > 0:
            plo, phi = np.percentile(d, [stretch * 100.0, (1.0 - stretch) * 100.0])
            if phi - plo > 1e-6:
                return np.clip((d - plo) / (phi - plo), 0.0, 1.0)
        return (d - lo) / (hi - lo)
    if mode == "v2_style":
        mu, sd = float(np.mean(d)), float(np.std(d))
        if sd < 1e-6:
            return np.zeros_like(d)
        z = (d - mu) / (2.0 * sd) + 0.5
        return np.clip(z, 0.0, 1.0)
    return d  # none


def _to_np_image(image):
    """ComfyUI IMAGE(1,H,W,C) -> (H,W,C) float32 numpy。"""
    arr = image
    if torch is not None and isinstance(arr, torch.Tensor):
        arr = arr.detach().cpu().float().numpy()
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 4:
        arr = arr[0]
    if arr.ndim == 2:
        arr = arr[..., None]
    return arr


def _to_np_mask(mask):
    arr = mask
    if torch is not None and isinstance(arr, torch.Tensor):
        arr = arr.detach().cpu().float().numpy()
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 3:
        arr = arr[0]
    return arr


def _as_batch(arr, channels):
    """(H,W,C) numpy -> torch (1,H,W,C)；ComfyUI 的 IMAGE 是 RGB（3 通道）。"""
    arr = arr.astype(np.float32)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], channels, axis=2)
    if arr.shape[2] == 1 and channels == 3:
        arr = np.repeat(arr, 3, axis=2)
    if arr.shape[2] > channels:
        arr = arr[..., :channels]
    arr = np.clip(arr, 0.0, 1.0)
    if torch is None:  # 裸 numpy 环境（测试用）
        return arr[None, ...]
    return torch.from_numpy(arr)[None, ...]


# ---------------------------------------------------------------------------
# 1) 深度精修
# ---------------------------------------------------------------------------
class DshDepthRefine:
    """把单目深度图修成「可做顶点位移」的深度图。

    做四件事：
      1. 导向滤波：用原图亮度做 guide，把深度边缘吸附到真实物体边缘；
      2. 边缘保持平滑：再跑一次半径更大的导向滤波（guide=深度自身），压掉块状噪声；
      3. 前景压平（可选）：给了 matte 时，把主体区域的深度替换成「主体中位深度」，
         这样前景整体前移/后移时不会被深度噪声撕成两半；
      4. 归一化 + 可选反相，输出 3 通道灰度 IMAGE（贴图用，数据通道）。
    """

    CATEGORY = "dsh/video-assets"
    OUTPUT_NODE = False
    FUNCTION = "refine"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("depth", "info")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("IMAGE", {"tooltip": "深度模型输出的灰度图（越白越近或越远，取决于模型）"}),
                "image": ("IMAGE", {"tooltip": "原图，作为导向滤波的引导图"}),
                "radius": ("INT", {"default": 12, "min": 1, "max": 64, "step": 1,
                                   "tooltip": "导向滤波半径：越大越平滑，越可能糊掉细结构"}),
                "eps": ("FLOAT", {"default": 0.01, "min": 0.0001, "max": 1.0, "step": 0.0001,
                                  "tooltip": "保边阈值：越小越贴合边缘，越大越平滑"}),
                "smooth_radius": ("INT", {"default": 24, "min": 0, "max": 128, "step": 1,
                                          "tooltip": "第二遍平滑半径（对深度自身做导向）"}),
                "flatten_foreground": ("BOOLEAN", {"default": True,
                                                   "tooltip": "给了 matte 时把主体区域压成平面深度，防止撕裂"}),
                "invert": ("BOOLEAN", {"default": False}),
                "normalize": (["v2_style", "min_max", "none"], {"default": "min_max"}),
            },
            "optional": {
                "matte": ("MASK", {"tooltip": "主体遮罩（白=主体），用于压平前景"}),
            },
        }

    def refine(self, depth, image, radius, eps, smooth_radius, flatten_foreground, invert, normalize,
               matte=None):
        import time
        t0 = time.perf_counter()
        d = _to_np_image(depth)
        d = _luma(d) if d.shape[2] >= 3 else d[..., 0]
        img = _to_np_image(image)
        guide = _luma(img)

        h, w = d.shape[:2]
        if guide.shape[:2] != (h, w):
            # 尺寸不一致时用最近邻粗暴对齐（正常情况下不会发生）
            yi = (np.arange(h) * guide.shape[0] / h).astype(np.int32)
            xi = (np.arange(w) * guide.shape[1] / w).astype(np.int32)
            guide = guide[yi][:, xi]

        d01 = d - float(np.min(d))
        mx = float(np.max(d01))
        d01 = d01 / mx if mx > 1e-6 else d01

        out = _guided_filter(guide, d01, int(radius), float(eps))
        if int(smooth_radius) > 0:
            out = _guided_filter(out, out, int(smooth_radius), float(eps) * 4.0)

        flat_note = "off"
        if flatten_foreground and matte is not None:
            m = _to_np_mask(matte)
            if m.shape[:2] != out.shape[:2]:
                yi = (np.arange(out.shape[0]) * m.shape[0] / out.shape[0]).astype(np.int32)
                xi = (np.arange(out.shape[1]) * m.shape[1] / out.shape[1]).astype(np.int32)
                m = m[yi][:, xi]
            hard = m > 0.5
            if hard.any():
                out = out.copy()
                out[hard] = float(np.median(out[hard]))
                flat_note = f"median={float(np.median(out[hard])):.3f}"

        out = _normalize(out, normalize)
        out = np.clip(out, 0.0, 1.0)
        if invert:
            out = 1.0 - out

        info = C.info_string(
            "depth-refine",
            radius=radius, eps=eps, smooth=smooth_radius, flatten=flat_note,
            invert=int(bool(invert)), norm=normalize, px=f"{w}x{h}",
            ms=C.elapsed_ms(t0),
        )
        return (_as_batch(out, 3), info)


# ---------------------------------------------------------------------------
# 2) 前景剥离 + 背景板修复
# ---------------------------------------------------------------------------
def _push_pull_fill(rgb, known, levels=8):
    """带掩码的 push-pull 金字塔回填：洞里填周围像素的加权均值（无幻觉）。"""
    h, w = known.shape
    pyr = []
    cur_rgb = rgb.astype(np.float64)
    cur_k = known.astype(np.float64)
    for _ in range(levels):
        if cur_k.shape[0] < 2 or cur_k.shape[1] < 2:
            break
        pyr.append((cur_rgb, cur_k))
        if cur_k.shape[0] % 2 == 1:
            cur_rgb = np.concatenate([cur_rgb, cur_rgb[-1:]], axis=0)
            cur_k = np.concatenate([cur_k, cur_k[-1:]], axis=0)
        if cur_k.shape[1] % 2 == 1:
            cur_rgb = np.concatenate([cur_rgb, cur_rgb[:, -1:]], axis=1)
            cur_k = np.concatenate([cur_k, cur_k[:, -1:]], axis=1)
        num = cur_rgb * cur_k[..., None]
        num = num.reshape(cur_k.shape[0] // 2, 2, cur_k.shape[1] // 2, 2, 3).sum(axis=(1, 3))
        den = cur_k.reshape(cur_k.shape[0] // 2, 2, cur_k.shape[1] // 2, 2).sum(axis=(1, 3))
        cur_rgb = num / np.maximum(den, 1e-6)[..., None]
        cur_k = den

    # 顶层整块抹平，然后逐级上采样补洞
    filled = cur_rgb
    for lvl in reversed(range(len(pyr))):
        base_rgb, base_k = pyr[lvl]
        hh, ww = base_k.shape
        yi = np.clip((np.arange(hh) * filled.shape[0] / hh).astype(np.int32), 0, filled.shape[0] - 1)
        xi = np.clip((np.arange(ww) * filled.shape[1] / ww).astype(np.int32), 0, filled.shape[1] - 1)
        up = filled[yi][:, xi]
        alpha = np.clip(base_k, 0.0, 1.0)[..., None]
        filled = base_rgb * alpha + up * (1.0 - alpha)
    return np.clip(filled, 0.0, 1.0)


def _feather(mask, radius):
    if radius <= 0:
        return mask
    return _box_mean(mask, int(radius))


def _dilate(mask, radius):
    if radius <= 0:
        return mask
    # 方框求和 > 0 即视为「半径内存在前景」→ 形态学膨胀
    return (_box_sum(mask, int(radius)) > 0.5).astype(np.float32)


class DshLayerSplit:
    """把「原图 + 主体遮罩」拆成前景（带 alpha）与背景板（洞被像素延展填掉）。

    `mode`：
      * `bg`  —— 只要背景板（主体已抹除，洞里是周围像素）
      * `fg`  —— 只要前景 RGBA（alpha = 羽化后的遮罩）
      * `both` —— 上下两个输出都出

    这套拆法让 2.5D 合成不会出现「前景被拽走、后面露出拉伸背景」的撕裂：
    背景板是一张完整的、干净的图，前景是独立的一块，二者在不同 z 上分别位移。
    """

    CATEGORY = "dsh/video-assets"
    OUTPUT_NODE = False
    FUNCTION = "split"
    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("background", "foreground_rgba", "mask", "info")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK", {"tooltip": "主体遮罩（白=主体）"}),
                "mode": (["both", "bg", "fg"], {"default": "both"}),
                "dilate": ("INT", {"default": 3, "min": 0, "max": 64, "step": 1,
                                   "tooltip": "抹除半径：遮罩向外扩几像素，防止主体边缘残留"}),
                "feather": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 64.0, "step": 0.5,
                                      "tooltip": "前景 alpha 羽化半径（像素）"}),
                "plate_blur": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 32.0, "step": 0.5,
                                         "tooltip": "背景板回填区域的轻微模糊，掩盖延展纹理"}),
            },
            "optional": {
                "invert_mask": ("BOOLEAN", {"default": False,
                                            "tooltip": "遮罩反相（上游给的是背景遮罩时打开）"}),
            },
        }

    def split(self, image, mask, mode, dilate, feather, plate_blur, invert_mask=False):
        import time
        t0 = time.perf_counter()
        rgb = _to_np_image(image)[..., :3]
        m = _to_np_mask(mask)
        h, w = rgb.shape[:2]
        if m.shape[:2] != (h, w):
            yi = (np.arange(h) * m.shape[0] / h).astype(np.int32)
            xi = (np.arange(w) * m.shape[1] / w).astype(np.int32)
            m = m[yi][:, xi]
        m = np.clip(m, 0.0, 1.0)
        if bool(invert_mask):
            m = 1.0 - m

        hole = _dilate((m > 0.5).astype(np.float32), int(dilate))
        known = 1.0 - hole

        bg = rgb.copy()
        if float(known.mean()) > 1e-4:
            filled = _push_pull_fill(rgb, known)
            bg = rgb * known[..., None] + filled * (1.0 - known[..., None])
        if float(plate_blur) > 0:
            r = int(round(float(plate_blur)))
            if r > 0:
                blur = np.stack([_box_mean(bg[..., c], r) for c in range(3)], axis=-1)
                bg = bg * known[..., None] + blur * (1.0 - known[..., None])

        fg = rgb.copy()
        alpha = _feather(m, float(feather))
        fg_rgba = np.concatenate([fg, np.clip(alpha, 0, 1)[..., None]], axis=2)

        if mode == "bg":
            fg_out = _as_batch(bg, 3)
            bg_out = _as_batch(bg, 3)
        elif mode == "fg":
            bg_out = _as_batch(fg_rgba, 4)
            fg_out = _as_batch(fg_rgba, 4)
        else:
            bg_out = _as_batch(bg, 3)
            fg_out = _as_batch(fg_rgba, 4)

        info = C.info_string(
            "layer-split", mode=mode, dilate=dilate, feather=feather, plate_blur=plate_blur,
            fg_ratio=f"{float((m > 0.5).mean()):.3f}", px=f"{w}x{h}", ms=C.elapsed_ms(t0),
        )
        return (bg_out, fg_out, torch.from_numpy(np.clip(m, 0, 1)) if torch is not None else m[None, ...], info)
