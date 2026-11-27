# Architecture

> How Video Forge turns a storyboard into frames, and why the pieces are split the way they are.

## 1. Design thesis

The renderer is deliberately **dumb**: it knows four deterministic primitives and nothing
about "cinematic" or "anime". All styling arrives as data — a `StyleSpec` injected by a
preset — so the same kernel produces every look, and a golden-frame diff is exact
(`maxDiff = 0`) instead of "close enough".

```
                storyboard (Markdown table or JSON shots)
                              │
                    ┌─────────▼──────────┐
                    │  Compiler (Host)   │  strategy + provider choice, cost estimate,
                    │  src/bridge/**     │  cache lookup, task DAG
                    └─────────┬──────────┘
                              │  RenderPlan (JSON contract)
                    ┌─────────▼──────────┐
                    │  Scheduler (Host)  │  GPU pool (ComfyUI) ⟂ API pool (Seedream /
                    │  src/core/**       │  MiniMax / MAGI-2), retries, atomic cache
                    └─────────┬──────────┘
                              │  assets on disk (sha256-addressed)
                    ┌─────────▼──────────┐
                    │ Remotion + Three.js│  deterministic stage, per-frame render,
                    │ remotion/src/**    │  ffmpeg mux
                    └─────────┬──────────┘
                              ▼
                        out/<planId>/…
```

Two processes, two responsibilities, hard boundary:

| Side | Directory | May contain | Must never contain |
| --- | --- | --- | --- |
| Host | `src/` | providers, scheduler, cache, HTTP, tools, console state | three.js, camera language, style names (except the id→prompt map) |
| Renderer | `remotion/src/` | three.js, shaders, presets, timeline | API keys, provider dispatch, network calls |

## 2. Contracts

Exactly two JSON contracts cross the process boundary. Both are implemented twice — once
as a type on each side — and pinned by the same fixture, so a change to one side fails CI
until the other matches.

| Contract | Host side | Renderer side | Fixture |
| --- | --- | --- | --- |
| `RenderPlan` | `src/bridge/render-plan.ts` | `remotion/src/plan/types.ts` | `fixtures/render-plan.example.json` |
| `TaskManifest` | `src/core/runtime.ts` | `remotion/src/plan/types.ts` | generated at run time |

`remotion/src/plan/parse.ts` is a defensive parser: recoverable problems are repaired with
defaults, structural errors are reported and fail the plan.

## 3. Strategies

A strategy is the smallest unit that decides *how* a shot becomes motion. Seven exist, and
the list is mirrored in `src/bridge/render-plan.ts`, `remotion/src/plan/types.ts` and the
console.

| Strategy | Still | Depth | Matte | Motion source | Typical use |
| --- | --- | --- | --- | --- | --- |
| `seedream-static` | ✓ | ✓ | – | deterministic parallax | cheapest, stylised |
| `still-3d` | ✓ | – | – | deterministic 3D stage | product / editorial |
| `minimax-direct` | – | – | – | MiniMax H3 text-to-video | pure T2V, layout motion |
| `minimax-2k-repaint` | ✓ | – | – | H3 re-shoots at 2K | 768P sharpness ceiling |
| `comfy-pipeline` | ✓ | ✓ | ✓ | H3 I2V on a composited plate | heavy post-processing |
| `magi2-direct` | ✓ | – | – | MAGI-2 native 1080p | 4–30 s real shots |
| `magi2-i2v` | ✓ (or per shot) | – | – | MAGI-2 image-to-video | first/last-frame control |

`minimax-2k-repaint` exists because H3 tops out at 768P: the compiler renders a still first,
feeds it back as the first frame, and asks H3 for a 2K take, so the upscale happens inside
the model instead of in ffmpeg.

## 4. Providers

| Provider | Role | Auth | Notes |
| --- | --- | --- | --- |
| Seedream 5.0 (Ark) | stills | `ARK_API_KEY` | `5.0-flash` default, alias-resolved |
| MiniMax H3 | T2V / I2V | `MINIMAX_API_KEY` | 480P / 768P / 2K, `-Lite` / `-Highspeed` tiers |
| Sand.ai MAGI-2 | native 1080p I2V | `SAND_API_KEY` | native API + Ark-hosted mode, ≤ 20 refs |
| ComfyUI | depth / matte / refine | none (loopback) | `http://127.0.0.1:8188` |
| `mock` | keyless end-to-end | none | deterministic fixtures for CI and demos |

Providers are interchangeable behind one interface (`src/core/providers/types.ts`), and the
scheduler treats the GPU (ComfyUI, default concurrency 1) and the API providers (default 3)
as separate pools so a locally saturated GPU never blocks remote calls.

## 5. Cache

Every produced asset — still, depth map, matte, video clip — is content-addressed:

```
sha256(provider + model + prompt + params) → cache/<2>/<hash>.<ext>
```

Writes are atomic (temp file + rename), reads are gated on a complete file, and the same
key is reused by retries. Re-running a plan after a crash costs nothing.

## 6. Control plane

Three Agent tools (`video_forge_status`, `video_forge_produce`, `video_forge_comfy_run`)
and a loopback-only HTTP API under `/api/dsh-video-forge`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | health, masked key state, MAGI-2 state, config path |
| POST | `/magi2/probe` | distinguish `invalid_api_key` from `insufficient_credits` |
| POST | `/config` | whitelisted settings (keys, endpoints, models, paths) |
| POST | `/produce` | compile + schedule a plan |
| GET | `/jobs` `/plans` `/plan/:id` | progress and history |
| GET | `/workflows` | ComfyUI workflow manifests |
| POST | `/check-plan` | validate a plan without rendering |
| GET | `/file/:key` | serve an asset by its key |
| POST | `/bridge` | ComfyUI → host callbacks (optional bearer token) |

`isLocalRequest` rejects anything that is not loopback with a matching `Origin`
(`403 forbidden: loopback only`). Keys are never returned unmasked.

## 7. ComfyUI bridge

Eight custom nodes ship in `comfyui-nodes/dsh-video-assets`. They cover depth, normals,
alpha matte, seamless tiling, asset inspection, template injection, an HTTP callback to the
host, and workflow manifests. Tensor nodes degrade explicitly: without numpy/torch the
package still imports, and execution raises a readable error instead of silently faking a
result.

## 8. Quality gates

| Gate | Command | What it proves |
| --- | --- | --- |
| Build | `bash scripts/build.sh` | host types + client bundle |
| Renderer types | `cd remotion && npx tsc -p tsconfig.json --noEmit` | the stage compiles |
| Plan contract | `node scripts/check-plan.mjs --all` | every fixture/preset is schema-valid |
| Visual static rules | `node scripts/check-quality.mjs` | six dimensions per preset, no fake algorithms |
| Golden frames | `node scripts/check-frames.mjs` | re-render is bit-stable (`maxDiff = 0`) |
| Node tests | `npm test` | 41 contract/runtime cases |
| Python nodes | `bash comfyui-nodes/.../run_checks.sh` | 50 node/contract cases |

Hygiene (`node scripts/check-hygiene.mjs`) is the eighth gate: it scans tracked files for
credentials, machine paths and > 5 MB blobs.

## 9. Repository layout

```
src/                 host side: bridge, core (providers/scheduler/cache/runtime), client UI
remotion/            renderer: engine primitives, presets, plan parser, render scripts
comfyui-nodes/       eight ComfyUI nodes + their Python tests
scripts/             build, gates, mock end-to-end, key entry
fixtures/            render-plan example + golden frame baselines
docs/                architecture, visual quality standard, visual QA log, media
tests/               41 node test cases (compiled lib + plan contract)
```
