import { Config } from '@remotion/cli/config'

/**
 * 离线渲染配置。
 * - 并发固定 1：WebGL 场景在多个标签页里抢显卡会掉帧，且确定性优先于速度。
 * - chromium 用 gl=swiftshader 兜底，避免无显卡机器 / CI 上拿不到 WebGL 上下文。
 * - 关闭 Remotion 的自动覆盖输入，保证 plan.json 原样进入 calculateMetadata。
 */
Config.setConcurrency(1)
Config.setVideoImageFormat('jpeg')
Config.setChromiumOpenGlRenderer('angle')
Config.setEntryPoint('./src/index.ts')
