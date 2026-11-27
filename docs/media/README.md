# README media

Every image the README references comes from one real render — the 15-second film
`墨卷山河 · Ink Scroll`. There are no mock-ups, no stock frames and no screenshots.

| File | What it shows | Source | Encoded specs |
| --- | --- | --- | --- |
| `hero-oriental-ink.webp` | **Hero, autoplaying** — the whole 15 s film, looping | `remotion/out/hero-oriental-ink-15s.mp4` | 800×450, 13 fps, 195 frames, 15.0 s, animated WebP, quality 72, loop forever, ≤ 5 MB (1.83 MB) |
| `hero-oriental-ink-poster.png` | Poster frame: crane with its vermilion crown, shot 2 | `remotion/out/hero-oriental-ink-15s.mp4` at frame 198 | 1920×1080 PNG, ≤ 1 MB (271 KB) |

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

## 中文说明

本目录只保留 README 首屏用到的两份素材：15 秒水墨片的高清封面帧
（`hero-oriental-ink-poster.png`）与自动循环动图（`hero-oriental-ink.webp`），两者都出自
同一次真机渲染，不含任何模拟图或占位图。

1080p 成片**不入库**——它作为 Release `v0.1.0` 的附件分发；首屏动图与封面都指向该附件，
因为 GitHub 会过滤 README 里的 `<video>` 标签，也不会自动播放仓库内的 `.mp4`。
