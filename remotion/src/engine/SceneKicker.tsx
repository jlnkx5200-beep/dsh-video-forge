/**
 * 把「资源到位」翻译成一次真实绘制。
 *
 * 为什么必须有它：`@remotion/three` 的 ThreeCanvas 在渲染期把 R3F 设成
 * `frameloop: 'never'`，只在 `useCurrentFrame()` 变化时调一次 `advance()`。
 * 所以贴图/视频帧加载完成、React 换上新材料之后，**除非我们主动 advance，
 * 否则 canvas 里还是上一张（占位）画面**，截图就会永远拍到占位纹理。
 *
 * 用法：放在 `<ThreeCanvas>` 内部（每个 Canvas 一个），它会把自己注册成
 * 全局踢帧器；`assetLoader.releaseAfterPaint()` 在放行 delayRender 之前调它。
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { setSceneKicker } from './assetLoader'

export function SceneReadyKicker(): null {
  const advance = useThree(state => state.advance)
  useEffect(() => {
    setSceneKicker(() => advance(performance.now()))
    return () => setSceneKicker(null)
  }, [advance])
  return null
}
