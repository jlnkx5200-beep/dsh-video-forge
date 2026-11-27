# Documentation

| Document | Audience | What it covers |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | contributors | design thesis, contracts, providers, cache, control plane, quality gates |
| [`visual-quality-standard.md`](visual-quality-standard.md) | anyone changing rendering code | the quality red lines, the six visual dimensions, the mandatory Visual QA loop (Chinese) |
| [`visual-qa-log.md`](visual-qa-log.md) | maintainers | per-round visual QA evidence: frames, scores, defects, fixes (Chinese) |
| [`media/`](media/) | everyone | demo GIF/MP4, hero stills, console screenshots and their regeneration commands |
| [`../AGENTS.md`](../AGENTS.md) | agents and contributors | hard repository rules, pipeline invariants, cost discipline (Chinese) |

`visual-quality-standard.md` is the gate document: an implementation that contradicts it is a
bug, not a style choice. The machine-checkable half of it runs as
`node scripts/check-quality.mjs` in CI; the subjective half (does it actually look good?)
is the manual review loop described in section 4 of that document.
