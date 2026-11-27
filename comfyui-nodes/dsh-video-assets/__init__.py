"""dsh-video-assets —— 低内存 ComfyUI 自定义节点包（素材处理 + 外部 API 桥）。

用途：外部 AI-video 管线（Seedream 出图 -> ComfyUI 素材处理 -> MiniMax 视频 ->
Three.js / Remotion 渲染）在 ComfyUI 里需要的轻量节点。

安装：把本目录（或 junction / 复制）放到
`<COMFYUI_DIR>/ComfyUI/custom_nodes/dsh-video-assets`，重启 ComfyUI。

本文件的安全契约：
* **import 期绝不抛异常** —— 没装 ComfyUI（没有 folder_paths/comfy）时也能被 import，
  测试可以在裸 Python 里加载本包；缺 numpy/torch 只会在节点执行时给出清晰报错。
* 不声明 WEB_DIRECTORY（本包不携带前端 JS）。
"""
from __future__ import annotations

try:  # 正常情况：ComfyUI 以包的方式加载 custom_nodes/<pack>/__init__.py
    from .assets import (
        DshAlphaMatte,
        DshAssetInspect,
        DshDepthEstimate,
        DshNormalFromDepth,
        DshSeamlessTiling,
    )
    from .bridge import (
        DshForgeBridgeCall,
        DshTemplateInject,
        DshWorkflowManifest,
    )
    from .refine import DshDepthRefine, DshLayerSplit
    from .depth_model import DshDepthModel
    from .common import PACK_NAME, PACK_VERSION
except ImportError:  # 兼底：极少数加载器把本目录当顶层模块
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from assets import (  # type: ignore
        DshAlphaMatte,
        DshAssetInspect,
        DshDepthEstimate,
        DshNormalFromDepth,
        DshSeamlessTiling,
    )
    from bridge import (  # type: ignore
        DshForgeBridgeCall,
        DshTemplateInject,
        DshWorkflowManifest,
    )
    from refine import DshDepthRefine, DshLayerSplit  # type: ignore
    from depth_model import DshDepthModel  # type: ignore
    from common import PACK_NAME, PACK_VERSION  # type: ignore

__version__ = PACK_VERSION

NODE_CLASS_MAPPINGS = {
    # A. 轻量素材处理
    "DshDepthEstimate": DshDepthEstimate,
    "DshNormalFromDepth": DshNormalFromDepth,
    "DshAlphaMatte": DshAlphaMatte,
    "DshSeamlessTiling": DshSeamlessTiling,
    "DshAssetInspect": DshAssetInspect,
    # A2. 画质精修
    "DshDepthRefine": DshDepthRefine,
    "DshLayerSplit": DshLayerSplit,
    "DshDepthModel": DshDepthModel,
    # B. API 桥 / 参数化
    "DshTemplateInject": DshTemplateInject,
    "DshForgeBridgeCall": DshForgeBridgeCall,
    "DshWorkflowManifest": DshWorkflowManifest,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DshDepthEstimate": "DSH 深度估计",
    "DshNormalFromDepth": "DSH 法线(由深度)",
    "DshAlphaMatte": "DSH 透明遮罩",
    "DshSeamlessTiling": "DSH 无缝贴图",
    "DshAssetInspect": "DSH 素材体检",
    "DshDepthRefine": "DSH 深度精修",
    "DshLayerSplit": "DSH 图层剥离",
    "DshDepthModel": "DSH 真深度(DA2)",
    "DshTemplateInject": "DSH 模板注入",
    "DshForgeBridgeCall": "DSH Forge 桥调用",
    "DshWorkflowManifest": "DSH 工作流清单",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "PACK_NAME",
    "PACK_VERSION",
    "__version__",
]
