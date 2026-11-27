# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-27

First public release: a style-agnostic AI video pipeline for DeepSeek Harness.

### Highlights

- **One deterministic stage, many styles.** The render kernel exposes only four
  deterministic primitives (depth parallax, spatial stills, video layers, compositing);
  every look is injected by a `StyleSpec` preset. Golden-frame diffs are exact
  (`maxDiff = 0`), so "change the style" never means "change the renderer".
- **Two complementary video engines.** MiniMax H3 for text-to-video, layout motion and
  cheap drafts (with a `minimax-2k-repaint` pass that re-shoots the 768P ceiling at 2K);
  Sand.ai MAGI-2 for native 1080p image-to-video, 4–30 s shots and up to 20 reference
  images at a flat price.
- **8 GB-consumer-GPU friendly.** GPU (ComfyUI) and API providers run in separate
  concurrency pools, and every produced asset is content-addressed by SHA-256, so
  re-renders and retries are free.
- **A real plugin, not a script.** Three Agent tools, a loopback-only HTTP control plane,
  a four-tab console (Compose / Jobs / Plans / Settings) and eight ComfyUI custom nodes.

### Added

- Storyboard → `RenderPlan` compiler with seven explicit strategies:
  `seedream-static`, `still-3d`, `minimax-direct`, `minimax-2k-repaint`,
  `comfy-pipeline`, `magi2-direct`, `magi2-i2v`.
- Providers: Seedream 5.0 (stills), MiniMax H3 (T2V / I2V), Sand.ai MAGI-2 (native +
  Ark-hosted), ComfyUI (depth / matte / refine), plus a `mock` provider for keyless runs.
- MAGI-2 key-state machine (`missing_key` → `invalid_key` → `pending_quota` → `ready`,
  plus `configured_unprobed`) and a `POST /api/dsh-video-forge/magi2/probe` endpoint that
  distinguishes `401 invalid_api_key` from `400 insufficient_credits`.
- Content-addressed cache (`sha256` keys, atomic writes) shared by stills, depth maps,
  mattes and video clips.
- Six commercial-grade presets with six explicitly declared visual dimensions:
  `cinematic-realism`, `editorial-minimal`, `anime-atmospheric`, `cyber-neon`,
  `oriental-ink`, `video-first`.
- Eight ComfyUI nodes: `DshDepthEstimate`, `DshNormalFromDepth`, `DshAlphaMatte`,
  `DshSeamlessTiling`, `DshAssetInspect`, `DshTemplateInject`, `DshForgeBridgeCall`,
  `DshWorkflowManifest`.
- Four-tab console UI with cost estimation per shot and a sanitizer for MAGI-2 payloads.
- `docs/media/` demo assets, English + Chinese README, architecture notes and a
  visual quality standard.

### Engineering

- **7 local gates**: build, Remotion typecheck, `check-plan --all`, `check-quality`,
  `check-frames` (golden frames), `npm test` (41 node test cases) and 50 Python node
  tests via `comfyui-nodes/dsh-video-assets/tests/run_checks.sh`.
- **CI** runs keyless and GPU-free on `ubuntu-latest`: hygiene scan → npm install →
  host typecheck → client bundle → node tests → Remotion typecheck → Python node tests.
- **`npm install` works without a DSH source checkout.** Host peer types come from the
  published `@deepseek-ai/*` packages, and `scripts/link-deps.mjs` wires the
  `cordis` ↔ `@deepseek-ai/cordis` module identity that TypeScript augmentation needs.
  Setting `DSH_CHECKOUT` still switches the build to a local DSH source tree.
- `scripts/check-hygiene.mjs` scans every tracked file for API keys, private keys,
  machine-specific paths and oversized blobs; it runs in CI and before every release.

### Fixed

Found and fixed while rendering the 15-second README hero film (`墨卷山河 · Ink Scroll`):

- **Video layers seek by shot-local frame, not by the global timeline frame.** Every shot
  scene stays mounted at once, so a video layer in shot 2 was asking its 4.5 s clip to seek
  to 5.5 s+; `seeked` never fired and the render died on Remotion's 33 s page timeout
  (`TimeoutError: waiting for the page to render the React component at frame 135`).
  `DeterministicVideoTexture` now reads `useShotScope().localFrame`.
- **Video seek target is clamped to the clip duration.** Inactive shots keep calling
  `acquireVideoFrame` with a growing local time; past the clip end Chrome clamps
  `currentTime` and stops emitting `seeked`, which wedged the page again at the
  shot 2 → shot 3 boundary (frame 301). `assetLoader.acquireVideoFrame` now clamps to
  `[0, duration - 1/fps]`.
- **`check-plan.mjs` no longer warns on every style preset.** Its `PRESETS_HINT` list only
  knew `spatial` / `parallax` / `video-first`, so `oriental-ink` (and the other four
  `StyleSpec` presets) produced a false "non-builtin preset" warning. It now lists all
  eight ids.
- **Ink preset no longer washes out under a long push-in.** `oriental-ink` drops
  `atmosphereOpacity` from 0.30 to 0.18 and moves `exposure`/`contrast` to 0.92/1.03,
  the two defects recorded in the R6 review ("推镜撞亮部", "雾占比过高"). `video-first`
  drops its particle field from 220 spheres @ 0.07 to 110 @ 0.035 so dust stops reading
  as grey snowballs on paper-white ink frames.

### Known limitations

- **MAGI-2 is waiting for quota.** The integration, the request contract and its unit
  tests are complete; the Sand.ai account behind them has not been granted generation
  quota yet, so runs surface `pending_quota` and fall back to a draft replay. Everything
  else in this release is exercised end-to-end.
- Audio from generated clips is preserved through the render (the demo ships an AAC track),
  but a planned music/SFX bed is not mixed yet: `RenderPlan.audio` exists in the contract and
  the parser accepts it, while no scene consumes it.
- Depth estimation uses a real model when available and refuses to fake it in
  `production` mode; the bundled fallback is `draft` only.
- 25 fps previs / editorial export is not implemented yet.

[0.1.0]: https://github.com/jlnkx5200-beep/dsh-video-forge/releases/tag/v0.1.0
