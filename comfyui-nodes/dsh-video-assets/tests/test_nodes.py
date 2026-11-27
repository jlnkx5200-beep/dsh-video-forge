"""dsh-video-assets 自测（unittest，stdlib 即可跑；pytest 也兼容）。

运行：
    python -m unittest discover -s tests -t . -v
    bash tests/run_checks.sh          # 自动挑带 numpy 的 python，逐个打印 PASS/FAIL

分层：
* 纯 Python 测试（**总是运行**）：包 import 安全、模板注入、清单 JSON、HTTP 桥（本地 stub server）
* 张量测试（numpy + torch 都在时才运行）：深度/法线/遮罩/无缝/体检
"""
from __future__ import annotations

import importlib
import importlib.abc
import importlib.util
import json
import os
import pathlib
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PACK_DIR = pathlib.Path(__file__).resolve().parents[1]
PACK_NAME_FOR_TEST = "dsh_video_assets_under_test"


def _have(named):
    try:
        __import__(named)
        return True
    except Exception:
        return False


HAVE_NUMPY = _have("numpy")
HAVE_TORCH = _have("torch")
HAVE_TENSOR_STACK = HAVE_NUMPY and HAVE_TORCH
SKIP_TENSOR = "需要 numpy + torch（ComfyUI venv 里才有）"


def load_pack(name: str = PACK_NAME_FOR_TEST):
    """用 importlib 以“包”的方式加载本节点包（目录名带 '-'，不能直接 import）。"""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name,
        str(PACK_DIR / "__init__.py"),
        submodule_search_locations=[str(PACK_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


PACK = load_pack()
BRIDGE = sys.modules[PACK.__name__ + ".bridge"]
COMMON = sys.modules[PACK.__name__ + ".common"]
CLASSES = PACK.NODE_CLASS_MAPPINGS


# ---------------------------------------------------------------------------
# 0) import 安全 & 节点契约
# ---------------------------------------------------------------------------
class TestImportSafety(unittest.TestCase):
    def test_mappings_exist(self):
        self.assertIsInstance(CLASSES, dict)
        self.assertGreaterEqual(len(CLASSES), 8)
        self.assertEqual(len(CLASSES), len(PACK.NODE_DISPLAY_NAME_MAPPINGS))
        for key in CLASSES:
            self.assertTrue(key.startswith("Dsh"), key)
        self.assertIn("NODE_CLASS_MAPPINGS", PACK.__all__)

    def test_no_web_directory(self):
        self.assertFalse(hasattr(PACK, "WEB_DIRECTORY"), "本包不携带前端 JS，不应声明 WEB_DIRECTORY")

    def test_every_node_contract(self):
        for key, cls in CLASSES.items():
            with self.subTest(node=key):
                self.assertTrue(callable(getattr(cls, "INPUT_TYPES", None)))
                spec = cls.INPUT_TYPES()
                self.assertIsInstance(spec, dict)
                self.assertIn("required", spec)
                self.assertIn("optional", spec)
                self.assertIsInstance(spec["required"], dict)
                self.assertIsInstance(spec["optional"], dict)
                for section in ("required", "optional"):
                    for iname, decl in spec[section].items():
                        self.assertIsInstance(decl, (list, tuple), f"{key}.{iname}")
                        self.assertGreater(len(decl), 0, f"{key}.{iname}")
                fn = getattr(cls, "FUNCTION", None)
                self.assertIsInstance(fn, str)
                self.assertTrue(callable(getattr(cls, fn, None)), f"{key}.{fn} 不可调用")
                self.assertIsInstance(cls.RETURN_TYPES, tuple)
                self.assertGreaterEqual(len(cls.RETURN_TYPES), 1)
                self.assertEqual(len(cls.RETURN_NAMES), len(cls.RETURN_TYPES), key)
                self.assertTrue(cls.CATEGORY.startswith("dsh/"), cls.CATEGORY)
                self.assertIsInstance(cls.OUTPUT_NODE, bool)
                self.assertTrue((cls.__doc__ or "").strip(), f"{key} 缺 docstring")

    def test_import_without_numpy_and_torch(self):
        """模拟裸 Python：缺 numpy/torch 时 import 仍然成功（节点执行时才报错）。"""
        saved = {m: sys.modules.pop(m, None) for m in ("numpy", "torch")}
        blocker = _ImportBlocker({"numpy", "torch"})
        sys.meta_path.insert(0, blocker)
        try:
            bare = load_pack("dsh_video_assets_bare_import")
        finally:
            sys.meta_path.remove(blocker)
            for mod, obj in saved.items():
                if obj is not None:
                    sys.modules[mod] = obj
        self.assertEqual(len(bare.NODE_CLASS_MAPPINGS), len(CLASSES))
        bare_common = sys.modules[bare.__name__ + ".common"]
        self.assertIsNone(bare_common.np)
        self.assertIsNone(bare_common.torch)
        node = bare.NODE_CLASS_MAPPINGS["DshDepthEstimate"]()
        with self.assertRaises(RuntimeError):
            node.estimate(None)


class _ImportBlocker(importlib.abc.MetaPathFinder):
    def __init__(self, names):
        self.names = set(names)

    def find_spec(self, fullname, path=None, target=None):  # noqa: D401
        if fullname.split(".")[0] in self.names:
            raise ImportError("blocked for test: " + fullname)
        return None


# ---------------------------------------------------------------------------
# 1) 模板注入
# ---------------------------------------------------------------------------
class TestTemplateInject(unittest.TestCase):
    def setUp(self):
        self.cls = CLASSES["DshTemplateInject"]

    def run_inject(self, template, payload="{}", strict=False):
        text, report = self.cls().inject(template=template, payload=payload, strict=strict)
        return text, json.loads(report)

    def test_nested_dot_path(self):
        text, report = self.run_inject(
            "a=${a.b.c} n=${n} f=${f}",
            json.dumps({"a": {"b": {"c": "X"}}, "n": 3}),
        )
        self.assertEqual(text, "a=X n=3 f=${f}")
        self.assertEqual(report["resolved"], ["a.b.c", "n"])
        self.assertEqual(report["unresolved"], ["f"])

    def test_fallback(self):
        text, report = self.run_inject("v=${missing:默认值}|", "{}")
        self.assertEqual(text, "v=默认值|")
        self.assertEqual(report["fallbacks"], ["missing"])
        self.assertEqual(report["unresolved"], [])

    def test_escape_literal(self):
        text, report = self.run_inject(r"\${a.b.c}", json.dumps({"a": {"b": {"c": "X"}}}))
        self.assertEqual(text, "${a.b.c}")
        self.assertEqual(report["resolved"], [])
        self.assertEqual(report["escaped"], 1)
        self.assertEqual(report["unresolved"], [])

    def test_escape_backslash_pair(self):
        text, _ = self.run_inject(r"\\${v}", json.dumps({"v": "X"}))
        self.assertEqual(text, r"\X")

    def test_strict_raises(self):
        with self.assertRaises(ValueError) as ctx:
            self.run_inject("${missing1} ${missing2}", "{}", strict=True)
        msg = str(ctx.exception)
        self.assertIn("missing1", msg)
        self.assertIn("missing2", msg)

    def test_non_strict_keeps_placeholder(self):
        text, report = self.run_inject("x=${nope}", "{}")
        self.assertEqual(text, "x=${nope}")
        self.assertEqual(report["unresolved"], ["nope"])

    def test_list_index_and_object_encoding(self):
        payload = json.dumps({"items": [{"p": "hello"}, {"p": "bye"}], "meta": {"w": 64}})
        text, _ = self.run_inject("${items.0.p}/${items.1.p}/${meta}", payload)
        self.assertEqual(text, "hello/bye/" + json.dumps({"w": 64}, separators=(",", ":")))

    def test_scalar_formatting(self):
        text, _ = self.run_inject("${t}|${f}|${i}|${fl}|${nil}", json.dumps(
            {"t": True, "f": False, "i": 7, "fl": 1.5, "nil": None}))
        self.assertEqual(text, "true|false|7|1.5|")

    def test_multiline_template(self):
        text, _ = self.run_inject('{\n  "prompt": "${p}"\n}\n', json.dumps({"p": "a b"}))
        self.assertEqual(text, '{\n  "prompt": "a b"\n}\n')

    def test_empty_template_and_payload(self):
        text, report = self.run_inject("", "")
        self.assertEqual(text, "")
        self.assertEqual(report["placeholders"], 0)

    def test_bad_payload_raises(self):
        with self.assertRaises(ValueError):
            self.run_inject("${a}", "{not json")
        with self.assertRaises(ValueError):
            self.run_inject("${a}", "[1,2,3]")

    def test_duplicate_keys_deduped(self):
        _, report = self.run_inject("${a}${a}", json.dumps({"a": 1}))
        self.assertEqual(report["resolved"], ["a"])
        self.assertEqual(report["placeholders"], 2)


# ---------------------------------------------------------------------------
# 2) 清单
# ---------------------------------------------------------------------------
class TestManifest(unittest.TestCase):
    def setUp(self):
        self.cls = CLASSES["DshWorkflowManifest"]

    def build(self, extra="{}"):
        raw, = self.cls().manifest(extra_json=extra)
        return json.loads(raw)

    def test_schema(self):
        data = self.build()
        for key in ("pack", "version", "node_count", "nodes", "preferred_pipeline",
                    "placeholder_syntax", "bridge", "media", "memory"):
            self.assertIn(key, data)
        self.assertEqual(data["pack"], "dsh-video-assets")
        self.assertEqual(data["node_count"], len(CLASSES))
        self.assertEqual({n["name"] for n in data["nodes"]}, set(CLASSES))

    def test_node_entries_have_contracts(self):
        data = self.build()
        by_name = {n["name"]: n for n in data["nodes"]}
        for name, entry in by_name.items():
            with self.subTest(node=name):
                self.assertTrue(entry["outputs"], name)
                for out in entry["outputs"]:
                    self.assertIn("name", out)
                    self.assertIn("type", out)
                self.assertIn("required", entry["inputs"])
                self.assertIn("optional", entry["inputs"])
                self.assertIsInstance(entry["placeholder_keys"], list)
                self.assertIn(entry["category"], ("dsh/video-assets", "dsh/bridge"))
        depth = by_name["DshDepthEstimate"]
        self.assertEqual([o["name"] for o in depth["outputs"]], ["depth", "info"])
        inputs = {i["name"]: i for i in depth["inputs"]["required"]}
        self.assertEqual(inputs["device"]["type"], "COMBO")
        self.assertIn("cuda", inputs["device"]["options"])
        self.assertEqual(inputs["max_side"]["default"], 1024)

    def test_preferred_pipeline_known(self):
        data = self.build()
        self.assertTrue(data["preferred_pipeline"])
        for name in data["preferred_pipeline"]:
            self.assertIn(name, CLASSES)

    def test_placeholder_syntax_documented(self):
        syntax = self.build()["placeholder_syntax"]
        self.assertIn("a.b.c", syntax["value"])
        self.assertIn("escape", syntax)

    def test_extra_json_merge_and_error(self):
        data = self.build('{"job_id": "abc"}')
        self.assertEqual(data["extra"]["job_id"], "abc")
        self.assertNotIn("extra_error", data)
        broken = self.build("{oops")
        self.assertIn("extra_error", broken)
        self.assertEqual(broken["extra"], {})


# ---------------------------------------------------------------------------
# 3) 桥（本地 http.server stub）
# ---------------------------------------------------------------------------
class _StubHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):  # 静音
        pass

    def _send(self, code, payload, reason=None, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(code, reason or "OK")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {"_raw": raw.decode("utf-8", "replace")}
        auth = self.headers.get("Authorization") or ""
        _StubHandler.requests.append({"path": self.path, "payload": payload, "auth": auth})

        if self.path.startswith("/boom"):
            self._send(500, b"server exploded", reason="Internal Server Error",
                       ctype="text/plain; charset=utf-8")
            return
        if self.path.startswith("/slow"):
            time.sleep(2.0)
            self._send(200, {"slow": True})
            return
        self._send(200, {
            "echo": payload,
            "has_auth": bool(auth),
            "auth_scheme": auth.split(" ")[0] if auth else "",
        })


class TestBridgeHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.node = CLASSES["DshForgeBridgeCall"]()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        _StubHandler.requests = []
        self.url = f"http://127.0.0.1:{self.port}/echo"

    def call(self, path="/echo", **kw):
        kw.setdefault("action", "health")
        kw.setdefault("params_json", "{}")
        kw.setdefault("api_key_env", "")
        kw.setdefault("timeout_sec", 10)
        return self.node.call(endpoint=f"http://127.0.0.1:{self.port}{path}", **kw)

    def test_success_shape(self):
        body, status = self.call(params_json='{"prompt": "一只猫", "width": 768}')
        self.assertTrue(status.startswith("200 "), status)
        self.assertIn("ok", status)
        data = json.loads(body)
        self.assertEqual(data["echo"]["action"], "health")
        self.assertEqual(data["echo"]["params"]["prompt"], "一只猫")
        self.assertEqual(data["echo"]["params"]["width"], 768)
        self.assertEqual(len(_StubHandler.requests), 1)
        self.assertEqual(_StubHandler.requests[0]["payload"]["action"], "health")

    def test_request_shape_is_action_params(self):
        self.call(action="seedream_t2i", params_json='{"prompt": "x"}')
        sent = _StubHandler.requests[0]["payload"]
        self.assertEqual(set(sent), {"action", "params"}, "请求体必须恰好是 {action, params}")
        self.assertEqual(sent["action"], "seedream_t2i")
        self.assertEqual(sent["params"], {"prompt": "x"})

    def test_auth_header_from_env(self):
        token = "s3cret-token-value"
        os.environ["DSH_TEST_TOKEN_ABC"] = token
        try:
            body, status = self.call("/echo", api_key_env="DSH_TEST_TOKEN_ABC")
        finally:
            os.environ.pop("DSH_TEST_TOKEN_ABC", None)
        data = json.loads(body)
        self.assertTrue(data["has_auth"])
        self.assertEqual(data["auth_scheme"], "Bearer")
        self.assertEqual(_StubHandler.requests[0]["auth"], "Bearer " + token)
        self.assertNotIn(token, status, "status 不能泄漏 token")
        self.assertNotIn(token, body, "返回值不能泄漏 token")

    def test_no_auth_when_env_missing(self):
        os.environ.pop("DSH_TEST_TOKEN_NOPE", None)
        body, _ = self.call("/echo", api_key_env="DSH_TEST_TOKEN_NOPE")
        self.assertFalse(json.loads(body)["has_auth"])

    def test_no_auth_when_env_name_empty(self):
        body, _ = self.call("/echo", api_key_env="")
        self.assertFalse(json.loads(body)["has_auth"])

    def test_http_error_returns_body_without_raising(self):
        body, status = self.call("/boom")
        self.assertEqual(body, "server exploded")
        self.assertTrue(status.startswith("error: HTTP 500"), status)
        self.assertIn("server exploded", status)

    def test_connection_refused_returns_error(self):
        body, status = self.node.call(
            endpoint="http://127.0.0.1:1/api/dsh-video-forge/bridge",
            action="health", params_json="{}", api_key_env="", timeout_sec=5)
        self.assertEqual(body, "")
        self.assertTrue(status.startswith("error:"), status)

    def test_timeout_returns_error(self):
        t0 = time.time()
        body, status = self.call("/slow", timeout_sec=1)
        self.assertEqual(body, "")
        self.assertIn("timeout", status)
        self.assertLess(time.time() - t0, 5)

    def test_invalid_params_json(self):
        body, status = self.call(params_json="{not json")
        self.assertEqual(body, "")
        self.assertTrue(status.startswith("error:"), status)
        self.assertEqual(_StubHandler.requests, [], "非法参数不应发出请求")

    def test_invalid_endpoint(self):
        _, status = self.node.call(endpoint="ftp://x/y", action="health",
                                   params_json="{}", api_key_env="")
        self.assertTrue(status.startswith("error:"), status)

    def test_dry_run_sends_nothing(self):
        token = "dry-run-secret"
        os.environ["DSH_TEST_TOKEN_DRY"] = token
        try:
            body, status = self.call(api_key_env="DSH_TEST_TOKEN_DRY", dry_run=True,
                                     action="minimax_t2v", params_json='{"prompt": "p"}')
        finally:
            os.environ.pop("DSH_TEST_TOKEN_DRY", None)
        self.assertEqual(_StubHandler.requests, [])
        self.assertTrue(status.startswith("dry-run"), status)
        preview = json.loads(body)
        self.assertTrue(preview["dry_run"])
        self.assertTrue(preview["auth"])
        self.assertEqual(preview["action"], "minimax_t2v")
        self.assertNotIn(token, body)
        self.assertNotIn(token, status)

    def test_build_request_headers(self):
        token = "tok1234-hdr"
        os.environ["DSH_TEST_TOKEN_HDR"] = token
        try:
            req, meta = BRIDGE._build_request("http://127.0.0.1:9/x", "health", {}, "DSH_TEST_TOKEN_HDR")
        finally:
            os.environ.pop("DSH_TEST_TOKEN_HDR", None)
        self.assertEqual(req.get_header("Authorization"), "Bearer " + token)
        self.assertEqual(req.get_method(), "POST")
        self.assertNotIn(token, json.dumps(meta))
        self.assertTrue(meta["has_token"])
        self.assertGreater(meta["bytes"], 0)


# ---------------------------------------------------------------------------
# 4) 张量节点（numpy + torch 都在时）
# ---------------------------------------------------------------------------
def _grad_image(h=40, w=64, batch=1, ch=3):
    """平滑渐变图：接缝指标才有意义（纯噪声接缝不可降）。"""
    import torch
    y = torch.linspace(0.0, 1.0, h).view(1, h, 1, 1)
    x = torch.linspace(0.0, 1.0, w).view(1, 1, w, 1)
    base = (0.75 * x + 0.25 * y).expand(batch, h, w, ch)
    return (base * 0.9 + 0.05).clamp(0.0, 1.0).float().contiguous()


def _seam(a):
    import numpy as np
    return float(np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0, :] - a[-1, :]).mean())


@unittest.skipUnless(HAVE_TENSOR_STACK, SKIP_TENSOR)
class TestTensorNodes(unittest.TestCase):
    def test_depth_fallback_shapes_and_info(self):
        node = CLASSES["DshDepthEstimate"]()
        img = _grad_image(32, 48, batch=1)
        depth, info = node.estimate(img, device="auto", max_side=1024)
        self.assertEqual(tuple(depth.shape), (1, 32, 48, 3))
        self.assertEqual(depth.dtype.name if hasattr(depth.dtype, "name") else str(depth.dtype),
                         "float32" if hasattr(depth.dtype, "name") else "torch.float32")
        self.assertGreaterEqual(float(depth.min()), 0.0)
        self.assertLessEqual(float(depth.max()), 1.0)
        self.assertIn("method=fallback", info)
        self.assertIn("device=", info)
        self.assertGreater(float(depth.std()), 0.0, "渐变图不应输出常数深度")

    def test_depth_downscale_and_restore(self):
        node = CLASSES["DshDepthEstimate"]()
        img = _grad_image(300, 500, batch=2)
        depth, info = node.estimate(img, device="cpu", max_side=256)
        self.assertEqual(tuple(depth.shape), (2, 300, 500, 3), "必须放大回原尺寸")
        self.assertIn("proc=256x154", info)
        self.assertIn("batch=2", info)

    def test_depth_clamps_max_side(self):
        node = CLASSES["DshDepthEstimate"]()
        depth, info = node.estimate(_grad_image(32, 32), device="cpu", max_side=5)
        self.assertIn("proc=32x32", info)  # clamp 到 256 后无需缩小
        self.assertEqual(tuple(depth.shape), (1, 32, 32, 3))

    def test_normal_unit_length(self):
        node = CLASSES["DshNormalFromDepth"]()
        depth = _grad_image(40, 64)
        normal, = node.compute(depth, strength=1.5, flip_green=False)
        self.assertEqual(tuple(normal.shape), (1, 40, 64, 3))
        n = normal.numpy() * 2.0 - 1.0
        length = (n ** 2).sum(axis=3) ** 0.5
        self.assertAlmostEqual(float(length.mean()), 1.0, places=3)
        self.assertTrue(bool((n[..., 2] > 0).all()), "法线 Z 必须朝前")

    def test_normal_flip_green(self):
        node = CLASSES["DshNormalFromDepth"]()
        depth = _grad_image(32, 48)
        a, = node.compute(depth, strength=2.0, flip_green=False)
        b, = node.compute(depth, strength=2.0, flip_green=True)
        self.assertAlmostEqual(float((a[..., 1] + b[..., 1] - 1.0).abs().mean()), 0.0, places=5)
        self.assertAlmostEqual(float((a[..., 0] - b[..., 0]).abs().max()), 0.0, places=6)

    def test_normal_invert_depth(self):
        """invert 后梯度反号 → 法线 X/Y 关于 0.5 互补，Z 不变。"""
        node = CLASSES["DshNormalFromDepth"]()
        depth = _grad_image(32, 48)
        a, = node.compute(depth, invert_depth=False)
        b, = node.compute(depth, invert_depth=True)
        for ch in (0, 1):
            self.assertLess(float((a[..., ch] + b[..., ch] - 1.0).abs().max()), 1e-5)
        self.assertLess(float((a[..., 2] - b[..., 2]).abs().max()), 1e-5)
        self.assertGreater(float((a[..., 0] - b[..., 0]).abs().max()), 1e-4, "invert 不应是空操作")

    def test_alpha_chroma_key_rgba(self):
        import torch
        node = CLASSES["DshAlphaMatte"]()
        img = torch.zeros(1, 32, 32, 3)
        img[..., 1] = 1.0                 # 纯绿底
        img[:, 8:24, 8:24, :] = 0.0
        img[:, 8:24, 8:24, 0] = 1.0       # 中间红块
        rgba, mask = node.matte(img, mode="chroma_key", key_color="#00FF00",
                                tolerance=0.2, softness=0.05, edge_feather=0)
        self.assertEqual(tuple(rgba.shape), (1, 32, 32, 4), "必须保留 alpha 通道")
        self.assertEqual(tuple(mask.shape), (1, 32, 32))
        a = mask.numpy()
        self.assertLess(float(a[:, 0:4, 0:4].mean()), 0.1, "绿底应被抠掉")
        self.assertGreater(float(a[:, 12:20, 12:20].mean()), 0.9, "红块应保留")
        self.assertGreaterEqual(float(a.min()), 0.0)
        self.assertLessEqual(float(a.max()), 1.0)

    def test_alpha_luma_and_threshold_and_feather(self):
        import torch
        node = CLASSES["DshAlphaMatte"]()
        img = torch.zeros(1, 16, 16, 3)
        img[:, :, :8, :] = 1.0
        rgba, mask = node.matte(img, mode="threshold", threshold=0.5, edge_feather=0)
        a = mask.numpy()
        self.assertAlmostEqual(float(a[:, :, :8].mean()), 1.0, places=5)
        self.assertAlmostEqual(float(a[:, :, 8:].mean()), 0.0, places=5)
        self.assertEqual(tuple(rgba.shape), (1, 16, 16, 4))

        _, feather_mask = node.matte(img, mode="threshold", threshold=0.5, edge_feather=6)
        fa = feather_mask.numpy()
        self.assertFalse(abs(float(fa[:, :, :8].mean()) - 1.0) < 1e-6, "羽化后边缘应过渡")
        self.assertGreater(float(fa[:, 6:10].min()), 0.0)
        self.assertLess(float(fa[:, 6:10].max()), 1.0)

    def test_alpha_preserves_input_alpha(self):
        import torch
        node = CLASSES["DshAlphaMatte"]()
        img = torch.ones(1, 8, 8, 4)
        img[..., 3] = 0.5
        _, mask = node.matte(img, mode="luma_key", threshold=0.0, softness=0.0)
        self.assertAlmostEqual(float(mask.mean()), 0.5, places=5)

    def test_alpha_invert(self):
        import torch
        node = CLASSES["DshAlphaMatte"]()
        img = torch.zeros(1, 8, 8, 3)
        img[:, :, :4, :] = 1.0
        _, m1 = node.matte(img, mode="threshold", threshold=0.5, invert=False)
        _, m2 = node.matte(img, mode="threshold", threshold=0.5, invert=True)
        self.assertAlmostEqual(float((m1 + m2 - 1.0).abs().mean()), 0.0, places=5)

    def test_seamless_modes_reduce_seam(self):
        node = CLASSES["DshSeamlessTiling"]()
        img = _grad_image(48, 64)
        before = _seam(img[0].numpy())
        for mode in ("wrap_blend", "mirror", "edge_blend"):
            with self.subTest(mode=mode):
                out, = node.make(img, mode=mode, blend_px=16)
                self.assertEqual(tuple(out.shape), (1, 48, 64, 3))
                after = _seam(out[0].numpy())
                self.assertLessEqual(after, before + 1e-5, f"{mode} 未降低接缝：{before}->{after}")
        for mode in ("mirror", "edge_blend"):
            out, = node.make(img, mode=mode, blend_px=16)
            self.assertLess(_seam(out[0].numpy()), 1e-4, f"{mode} 接缝应严格为 0")

    def test_seamless_blend_px_zero(self):
        node = CLASSES["DshSeamlessTiling"]()
        img = _grad_image(32, 32)
        out, = node.make(img, mode="edge_blend", blend_px=0)
        self.assertEqual(tuple(out.shape), (1, 32, 32, 3))

    def test_inspect_json(self):
        import torch
        node = CLASSES["DshAssetInspect"]()
        img = _grad_image(24, 32, batch=1)
        raw, = node.inspect(img, max_side=64, top_colors=4)
        data = json.loads(raw)
        self.assertEqual(data["width"], 32)
        self.assertEqual(data["height"], 24)
        self.assertEqual(data["channels"], 3)
        self.assertFalse(data["has_alpha"])
        self.assertTrue(data["is_opaque"])
        self.assertLessEqual(len(data["dominant_colors"]), 4)
        self.assertGreater(len(data["dominant_colors"]), 0)
        for entry in data["dominant_colors"]:
            self.assertTrue(entry["hex"].startswith("#"))
            self.assertGreaterEqual(entry["ratio"], 0.0)
        # 渐变图bin很分散：ratio 是「占全部采样像素的比例」，top-N 求和不必然为 1
        self.assertLessEqual(sum(c["ratio"] for c in data["dominant_colors"]), 1.0 + 1e-6)
        self.assertGreater(sum(c["ratio"] for c in data["dominant_colors"]), 0.02)

    def test_inspect_dominant_colors_on_solid_image(self):
        import torch
        node = CLASSES["DshAssetInspect"]()
        img = torch.zeros(1, 16, 16, 3)
        img[:, :, :8, :] = torch.tensor([1.0, 0.0, 0.0])
        img[:, :, 8:, :] = torch.tensor([0.0, 0.0, 1.0])
        data = json.loads(node.inspect(img, max_side=64, top_colors=4)[0])
        self.assertLessEqual(len(data["dominant_colors"]), 4)
        self.assertAlmostEqual(sum(c["ratio"] for c in data["dominant_colors"]), 1.0, places=3)
        self.assertAlmostEqual(data["dominant_colors"][0]["ratio"], 0.5, places=2)

    def test_inspect_detects_transparency(self):
        import torch
        node = CLASSES["DshAssetInspect"]()
        img = torch.ones(1, 8, 8, 4)
        img[..., 3] = 0.5
        data = json.loads(node.inspect(img)[0])
        self.assertTrue(data["has_alpha"])
        self.assertFalse(data["is_opaque"])
        self.assertAlmostEqual(data["alpha_min"], 0.5, places=3)

    def test_inspect_large_image_is_sampled(self):
        node = CLASSES["DshAssetInspect"]()
        img = _grad_image(512, 512)
        t0 = time.time()
        data = json.loads(node.inspect(img, max_side=32)[0])
        self.assertLess(time.time() - t0, 2.0)
        self.assertGreater(data["sample"]["step"], 1)

    def test_batch_consistency(self):
        node = CLASSES["DshDepthEstimate"]()
        img = _grad_image(16, 16, batch=3)
        depth, info = node.estimate(img, device="cpu")
        self.assertEqual(tuple(depth.shape), (3, 16, 16, 3))
        self.assertIn("batch=3", info)


if __name__ == "__main__":
    unittest.main(verbosity=2)
