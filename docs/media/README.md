# README media

Every image the README references. All of it comes from one real render — the
15-second film `墨卷山河 · Ink Scroll` — plus two console screenshots that are still
placeholders (see below).

| File | What it shows | Source | Encoded specs |
| --- | --- | --- | --- |
| `hero-oriental-ink.webp` | **Hero, autoplaying** — the whole 15 s film, looping | `remotion/out/hero-oriental-ink-15s.mp4` | 800×450, 13 fps, 195 frames, 15.0 s, animated WebP, quality 72, loop forever, ≤ 5 MB (1.83 MB) |
| `hero-oriental-ink-poster.png` | Poster frame: crane with its vermilion crown, shot 2 | `remotion/out/hero-oriental-ink-15s.mp4` at frame 198 | 1920×1080 PNG, ≤ 1 MB (271 KB) |
| `console-produce.png` | Placeholder for the Produce tab screenshot | generated (ffmpeg `drawtext`) | 1600×1000, 8-bit RGB, dark `#0d1117`, ≤ 150 KB (35.7 KB) |
| `console-plans.png` | Placeholder for the Plans tab screenshot | generated (ffmpeg `drawtext`) | 1600×1000, 8-bit RGB, dark `#0d1117`, ≤ 150 KB (34.2 KB) |

The 1080p film itself is **not** committed. It ships as a Release asset:

```
https://github.com/jlnkx5200-beep/dsh-video-forge/releases/download/v0.1.0/hero-oriental-ink-15s.mp4
```

Both the hero WebP and the poster link there, because GitHub's Markdown sanitizer strips
`<video>` and does not autoplay a committed `.mp4` inside a README.

## Regenerating the hero assets

The film is deterministic: same plan + same assets → same frames.

```bash
cd remotion
node scripts/render.mjs public/forge/plan-wmxu7h/plan.json \
  out/hero-oriental-ink-15s.mp4 --crf=18 --concurrency=2
```

Then, from the repo root (`ffmpeg` on `PATH`):

```bash
# autoplaying hero (keep it under 5 MB; raise -q:v only if it is too soft)
ffmpeg -y -i remotion/out/hero-oriental-ink-15s.mp4 -an \
  -vf "fps=13,scale=800:-1:flags=lanczos" \
  -c:v libwebp -lossless 0 -q:v 72 -compression_level 6 -loop 0 \
  docs/media/hero-oriental-ink.webp

# poster frame (frame 198 = the crane)
ffmpeg -y -i remotion/out/hero-oriental-ink-15s.mp4 -vf "select=eq(n\,198)" \
  -frames:v 1 docs/media/hero-oriental-ink-poster.png
```

## Screenshots to capture manually

Two files are placeholders and should be replaced with real captures of the DSH desktop console:

1. **`docs/media/console-produce.png`** — DSH desktop console, **Produce** tab, with a loaded
   storyboard visible (shot list and preview).
2. **`docs/media/console-plans.png`** — DSH desktop console, **Plans** tab, showing the list of
   generated plans with their thumbnails.

Both must be **1600×1000 PNG, ≤ 300 KB**, dark theme. Keep personal paths and any API keys out
of the frame — crop or mask the part of the window that shows them.

Replace the files in place: the README points at these exact paths, so dropping new captures at
the same filenames makes the README update automatically — no markdown edit needed. To hit the
300 KB ceiling, re-encode if your capture is larger:

```bash
ffmpeg -i capture.png -vf "scale=1600:1000" -pix_fmt rgb24 docs/media/console-produce.png
```

## 中文说明

本目录只保留 README 首屏用到的素材：15 秒水墨片的高清封面帧（`hero-oriental-ink-poster.png`）
与自动循环动图（`hero-oriental-ink.webp`），以及两张待替换的控制台截图占位图。

1080p 成片**不入库**——它作为 Release `v0.1.0` 的附件分发；首屏动图与封面都指向该附件，
因为 GitHub 会过滤 README 里的 `<video>` 标签，也不会自动播放仓库内的 `.mp4`。
