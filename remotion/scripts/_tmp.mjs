/**
 * 渲染脚本共用的子进程环境。
 *
 * 为什么需要它（真机踩过的坑，2026-11）：
 * Remotion 会 `mkdtemp(os.tmpdir()/puppeteer_dev_chrome_profile-XXXXXX)` 建 Chrome 用户目录，
 * 再用自带 ffmpeg 在临时目录里出静音 wav。若进程继承的 `TEMP=/tmp` 这类 **MSYS 风格路径**，
 * Windows 原生子进程会把它按「当前盘符 + Git 安装目录」解析成 `C:\Program Files\Git\tmp`：
 *   - 该目录不存在 → `Error: ENOENT: no such file or directory, mkdtemp 'C:\Program Files\Git\...'`
 *   - 该目录存在但不可写 → `Permission denied`
 * 历史记录把这条错误归因成「ffmpeg 生成静音 wav 失败」，实际是**浏览器临时目录**建不出来，
 * 渲染在出第 0 帧之前就退出了。因此这里统一把 TEMP/TMP/TMPDIR 指到插件自己的可写目录。
 *
 * 落点与插件 `ForgePaths.tmpDir` 一致：`$DSH_HOME/video-forge/tmp`（默认 `~/.dsh/video-forge/tmp`），
 * 可用 `DSH_FORGE_TMP` 覆盖。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 解析并确保存在渲染临时目录。 */
export function forgeTmpDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dir = process.env.DSH_FORGE_TMP ?? join(home, 'video-forge', 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 给 Remotion / FFmpeg 子进程用的环境变量（TEMP 三件套 + 时区）。 */
export function spawnEnv(extra) {
  const tmp = forgeTmpDir()
  return {
    ...process.env,
    TZ: process.env.TZ ?? 'Asia/Shanghai',
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    ...extra,
  }
}
