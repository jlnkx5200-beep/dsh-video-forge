"""dsh-video-assets —— 真·单目深度节点（Depth Anything V2，transformers 后端）。

为什么不用 ComfyUI 自带的 DA3 节点：
  ComfyUI 0.42 的 `LoadDA3Model` 只认它自己 `scripts/convert_da3.py` 重打包过的权重
  （Dinov2Model 布局），而 modelscope 上能拿到的 `depth-anything/DA3-Small` 是**原始仓库布局**
  （`model.backbone.pretrained.blocks.*`），`load_diffusion_model` 会直接
  `Could not detect model type`。与其手写一份易碎的键名重映射，这里改用
  `transformers` 的 `DepthAnythingForDepthEstimation`（transformers 5.x 原生支持），
  加载官方 **Depth Anything V2 Small HF 权重**，同样的模型、同样的精度，但加载路径稳定。

纪律：
* **绝不联网**：只从本地目录加载（`DSH_DEPTH_MODEL_DIR` 或 ComfyUI 的 `models/depth_anything_v2/`）；
  找不到就抛错，不静默降级成伪深度（画质红线，见 docs/visual-quality-standard.md）。
* 输出约定：**近处亮（1）、远处暗（0）**，与 `remotion/src/engine/glsl.ts` 的 PARALLAX_VERT 一致。
* 8GB 显存：长边缩到 max_side 再推理，再上采样回原尺寸；fp16 + no_grad + 用完释放缓存。
"""
from __future__ import annotations

import os
import time

try:  # 作为包的一部分被 import
    from . import common as C
except ImportError:
    import common as C  # type: ignore

np = C.np
torch = C.torch

_CACHE = {"key": None, "model": None, "processor": None}


def _candidate_roots():
    roots = []
    env = os.environ.get("DSH_DEPTH_MODEL_DIR", "").strip()
    if env:
        roots.append(env)
    fp = C.folder_paths
    if fp is not None:
        for name in ("depth_anything_v2", "depthanything", "geometry_estimation", "diffusers"):
            try:
                roots.extend(list(fp.get_folder_paths(name) or ()))
            except Exception:
                pass
    here = os.path.dirname(os.path.abspath(__file__))
    comfy_root = os.path.abspath(os.path.join(here, "..", ".."))
    roots.append(os.path.join(comfy_root, "models", "depth_anything_v2"))
    return roots


def _find_model_dirs():
    """返回所有「看起来是 HF 深度模型目录」的路径（含 config.json + 权重）。"""
    found = []
    seen = set()
    for root in _candidate_roots():
        if not root or not os.path.isdir(root):
            continue
        stack = [root]
        depth = 0
        while stack and depth < 4000:
            cur = stack.pop()
            depth += 1
            try:
                entries = list(os.scandir(cur))
            except OSError:
                continue
            names = {e.name for e in entries}
            has_cfg = "config.json" in names
            has_w = any(n.endswith((".safetensors", ".bin")) for n in names)
            if has_cfg and has_w:
                key = os.path.normcase(os.path.abspath(cur))
                if key not in seen:
                    seen.add(key)
                    found.append(os.path.abspath(cur))
                continue
            for e in entries:
                if e.is_dir():
                    stack.append(e.path)
    return found


def _pick_model_dir(model_dir: str) -> str:
    if model_dir and model_dir.strip():
        path = model_dir.strip()
        if os.path.isdir(path):
            return path
        raise ValueError(f"指定的深度模型目录不存在：{path}")
    dirs = _find_model_dirs()
    if not dirs:
        raise FileNotFoundError(
            "没有找到本地 Depth Anything V2 权重。把 HF 格式的模型目录放到 "
            "`ComfyUI/models/depth_anything_v2/`（需要 config.json + model.safetensors），"
            "或用环境变量 DSH_DEPTH_MODEL_DIR 指定。production 模式不允许退回伪深度。"
        )
    # 优先 Small / Base（8GB 友好）
    dirs.sort(key=lambda p: (0 if "small" in p.lower() else 1 if "base" in p.lower() else 2, len(p)))
    return dirs[0]


def _load(model_dir: str, device: str):
    from transformers import AutoImageProcessor, DepthAnythingForDepthEstimation

    key = (os.path.normcase(model_dir), device)
    if _CACHE["key"] == key and _CACHE["model"] is not None:
        return _CACHE["model"], _CACHE["processor"]

    processor = AutoImageProcessor.from_pretrained(model_dir)
    model = DepthAnythingForDepthEstimation.from_pretrained(model_dir)
    model.eval()
    if device == "cuda":
        model = model.to(dtype=torch.float16)
    model = model.to(device)
    _CACHE.update({"key": key, "model": model, "processor": processor})
    return model, processor


class DshDepthModel:
    """Depth Anything V2（真模型）→ 归一化深度图。"""

    CATEGORY = "dsh/video-assets"
    OUTPUT_NODE = False
    FUNCTION = "estimate"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("depth", "info")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "max_side": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 64,
                                     "tooltip": "推理前把长边缩到这个尺寸（显存与速度的平衡）"}),
                "device": (["auto", "cuda", "cpu"], {"default": "auto"}),
                "invert": ("BOOLEAN", {"default": True,
                                       "tooltip": "DA2 输出越大=越远；打开以转成『近处亮』的约定"}),
                "normalize": (["min_max", "v2_style", "none"], {"default": "min_max"}),
            },
            "optional": {
                "model_dir": ("STRING", {"default": "", "tooltip": "留空=自动在 models/depth_anything_v2 下找"}),
            },
        }

    def estimate(self, image, max_side, device, invert, normalize, model_dir=""):
        if torch is None or np is None:
            raise RuntimeError("DshDepthModel 需要 torch + numpy")

        t0 = time.perf_counter()
        dev = device
        if dev == "auto":
            dev = "cuda" if torch.cuda.is_available() else "cpu"
        if dev == "cuda" and not torch.cuda.is_available():
            dev = "cpu"

        path = _pick_model_dir(model_dir)
        model, processor = _load(path, dev)

        arr = image
        if isinstance(arr, torch.Tensor):
            arr = arr.detach().cpu().float().numpy()
        arr = np.asarray(arr, dtype=np.float32)
        if arr.ndim == 4:
            arr = arr[0]
        if arr.ndim == 2:
            arr = np.repeat(arr[..., None], 3, axis=2)
        arr = np.clip(arr[..., :3], 0.0, 1.0)

        from PIL import Image as PILImage
        h, w = arr.shape[:2]
        scale = float(max_side) / float(max(h, w))
        if scale < 1.0:
            nw, nh = max(64, int(round(w * scale))), max(64, int(round(h * scale)))
            pil_small = PILImage.fromarray((arr * 255.0).astype(np.uint8)).resize((nw, nh), PILImage.LANCZOS)
        else:
            pil_small = PILImage.fromarray((arr * 255.0).astype(np.uint8))

        inputs = processor(images=pil_small, return_tensors="pt")
        if dev == "cuda":
            inputs = {k: (v.to(device=dev, dtype=torch.float16) if v.is_floating_point() else v.to(dev))
                      for k, v in inputs.items()}
        else:
            inputs = {k: v.to(dev) for k, v in inputs.items()}

        with torch.no_grad():
            out = model(**inputs)
            pred = out.predicted_depth  # (1, h', w') 越大=越远
            pred = torch.nn.functional.interpolate(
                pred.unsqueeze(1).float(), size=(h, w), mode="bicubic", align_corners=False
            ).squeeze(1)[0].cpu().numpy()

        if dev == "cuda":
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        d = pred.astype(np.float32)
        lo, hi = float(np.min(d)), float(np.max(d))
        if normalize == "min_max":
            d = (d - lo) / (hi - lo) if hi - lo > 1e-6 else np.zeros_like(d)
        elif normalize == "v2_style":
            mu, sd = float(np.mean(d)), float(np.std(d))
            d = np.clip((d - mu) / (2.0 * sd) + 0.5, 0.0, 1.0) if sd > 1e-6 else np.zeros_like(d)
        if invert:
            d = 1.0 - d
        d = np.clip(d, 0.0, 1.0).astype(np.float32)

        if torch is None:
            batch = d[None, ..., None].repeat(3, axis=3)
        else:
            batch = torch.from_numpy(np.repeat(d[..., None], 3, axis=2))[None, ...]

        info = C.info_string(
            "depth-da2", model=os.path.basename(path), device=dev, proc=f"{pil_small.size[0]}x{pil_small.size[1]}",
            px=f"{w}x{h}", invert=int(bool(invert)), norm=normalize, ms=C.elapsed_ms(t0),
        )
        return (batch, info)
