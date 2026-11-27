/**
 * 2K 重绘策略（P1-2）：H3 的 768P 是上游上限，锐度天花板只能靠"静帧当首帧 + 2K 直出"顶。
 * 验编译产物：视频任务必须 resolution='2K'，且首帧来自静帧任务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileStoryboard } from '../lib/bridge/compiler.js'

const storyboard = {
  id: 'plan-2k',
  title: '2K 重绘',
  width: 1920,
  height: 1080,
  fps: 30,
  preset: 'cinematic-realism',
  style: { tags: [] },
  shots: [{ id: 'shot-1', shot: '中景', durationSec: 5, prompt: 'a steel teapot on a wet table' }],
}

test('minimax-2k-repaint：静帧 + 2K 直出，视频任务吃 first_frame', () => {
  const compiled = compileStoryboard(storyboard, { defaultStrategy: 'minimax-2k-repaint' })
  const still = compiled.tasks.find(t => t.id === 'shot-1:still')
  const video = compiled.tasks.find(t => t.id === 'shot-1:video')
  assert.ok(still !== undefined, '2K 重绘必须先出静帧')
  assert.ok(video !== undefined, '2K 重绘必须有视频任务')
  assert.equal(video.provider, 'minimax')
  assert.equal(video.params.resolution, '2K')
  assert.deepEqual(video.needs, [{ role: 'first_frame', from: 'shot-1:still' }])
  assert.equal(compiled.plan.shots[0].strategy, 'minimax-2k-repaint')
  assert.ok(compiled.plan.shots[0].video !== undefined)
})

test('2K 重绘不吃 minimaxResolution 参数（它是策略自带的分辨率）', () => {
  const compiled = compileStoryboard(storyboard, { defaultStrategy: 'minimax-2k-repaint', minimaxResolution: '480P' })
  const video = compiled.tasks.find(t => t.id === 'shot-1:video')
  assert.equal(video.params.resolution, '2K')
})

test('对照：minimax-direct 仍然是纯 T2V（无静帧、分辨率听参数）', () => {
  const compiled = compileStoryboard(storyboard, { defaultStrategy: 'minimax-direct', minimaxResolution: '768P' })
  assert.equal(compiled.tasks.some(t => t.id === 'shot-1:still'), false)
  const video = compiled.tasks.find(t => t.id === 'shot-1:video')
  assert.equal(video.params.resolution, '768P')
  assert.deepEqual(video.needs, [])
})
