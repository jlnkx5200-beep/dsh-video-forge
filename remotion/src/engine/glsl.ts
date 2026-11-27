/**
 * 全部 GLSL 集中在这里，便于审阅与替换。
 * 约定：
 *   - 所有 shader 只吃 uniform，不依赖外部状态（离线下可重放）
 *   - 随机一律用 hash 函数（uSeed + uv），绝不用 Math.random 或 time
 *   - 颜色运算在线性近似空间做，最后一步做 ACES 近似 tonemap
 */

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** 噪点 hash：稳定、无纹理依赖。 */
const HASH = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`

/** 亮度阈值提取（泛光第一步），顺便 4 tap 降采样。 */
export const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D uSource;
uniform float uThreshold;
uniform float uSoftKnee;
uniform vec2 uTexel;
varying vec2 vUv;

vec3 fetch(vec2 uv) { return texture2D(uSource, uv).rgb; }

void main() {
  vec3 acc = vec3(0.0);
  acc += fetch(vUv + uTexel * vec2(-1.0, -1.0));
  acc += fetch(vUv + uTexel * vec2( 1.0, -1.0));
  acc += fetch(vUv + uTexel * vec2(-1.0,  1.0));
  acc += fetch(vUv + uTexel * vec2( 1.0,  1.0));
  acc *= 0.25;
  float lum = dot(acc, vec3(0.2126, 0.7152, 0.0722));
  float knee = max(uSoftKnee, 0.0001);
  float w = smoothstep(uThreshold - knee, uThreshold + knee, lum);
  gl_FragColor = vec4(acc * w, 1.0);
}
`

/** 可分离高斯模糊（9 tap），用 uDirection 控制横向/纵向。 */
export const BLUR_FRAG = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uRadius;
varying vec2 vUv;

void main() {
  vec2 step0 = uTexel * uDirection * uRadius;
  vec3 acc = texture2D(uSource, vUv).rgb * 0.2270270270;
  acc += texture2D(uSource, vUv + step0 * 1.3846153846).rgb * 0.3162162162;
  acc += texture2D(uSource, vUv - step0 * 1.3846153846).rgb * 0.3162162162;
  acc += texture2D(uSource, vUv + step0 * 3.2307692308).rgb * 0.0702702703;
  acc += texture2D(uSource, vUv - step0 * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(acc, 1.0);
}
`

/**
 * 合成：景深近似 + 泛光叠加 + 色彩分级 + 暗角 + 胶片颗粒。
 * 景深是"屏幕空间径向近似"：以 uFocus 点为中心按 uDof 强度做多环采样，
 * 不是物理正确的 CoC，但对运镜镜头足够，且没有深度缓冲依赖（视频平面也能拿到）。
 */
export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uSource;
uniform sampler2D uBloom;
uniform sampler2D uOverlay;
uniform float uUseOverlay;
uniform float uOverlayOpacity;
uniform vec2 uTexel;
uniform float uBloomStrength;
uniform float uDof;
uniform vec2 uFocus;
uniform float uGrain;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform float uExposure;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSeed;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;

${HASH}

vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 sampleDof(vec2 uv) {
  if (uDof <= 0.0001) return texture2D(uSource, uv).rgb;
  vec2 center = uFocus;
  vec2 delta = uv - center;
  float dist = length(delta);
  float radius = uDof * 0.035 * smoothstep(0.05, 0.75, dist);
  vec3 acc = texture2D(uSource, uv).rgb;
  float total = 1.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float ang = fi * 2.3999632;
    vec2 off = vec2(cos(ang), sin(ang)) * radius * (0.35 + 0.65 * fract(fi * 0.37));
    acc += texture2D(uSource, uv + off).rgb;
    total += 1.0;
  }
  return acc / total;
}

void main() {
  vec3 base = sampleDof(vUv);
  vec3 bloom = texture2D(uBloom, vUv).rgb;
  vec3 color = base + bloom * uBloomStrength;

  if (uUseOverlay > 0.5) {
    vec4 ov = texture2D(uOverlay, vUv);
    color = mix(color, ov.rgb, ov.a * uOverlayOpacity);
  }

  // ── 正确的色彩管线顺序（曾经的 bug：先在**线性**空间做 pow(1/2.2) 再做 ACES，
  //    等于把画面整体抬亮一档，深谷被抬成中灰、雾面糊成一片白）：
  //    线性曝光 → ACES 色调映射 → sRGB 编码 → 在**显示域**做 lift/gain/对比度/饱和度/暗角/颗粒。
  color = color * uExposure;
  color = aces(max(color, vec3(0.0)));

  // 线性 → sRGB 编码
  vec3 srgb = mix(
    color * 12.92,
    1.055 * pow(max(color, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), color)
  );

  // 显示域分级（默认参数下几乎不动画面，只用于预设的"风格"）
  srgb = srgb * uGain + uLift * (1.0 - srgb);
  srgb = (srgb - 0.5) * uContrast + 0.5;
  float lum = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
  srgb = mix(vec3(lum), srgb, uSaturation);

  // 暗角
  vec2 d = vUv - 0.5;
  float vig = 1.0 - uVignette * dot(d, d) * 2.4;
  srgb *= clamp(vig, 0.0, 1.0);

  // 胶片颗粒：按帧 + 像素 hash，确定性
  if (uGrain > 0.0001) {
    float g = hash21(vUv * uResolution + vec2(uSeed * 37.0, uTime * 91.0));
    srgb += (g - 0.5) * uGrain;
  }

  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`

/**
 * 转场混合器：把 from / to 两张 RT 按转场类型合成。
 * uMode: 0 crossfade / 1 radial-blur / 2 luma-wipe / 3 noise-dissolve / 4 push
 */
export const TRANSITION_FRAG = /* glsl */ `
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform sampler2D uMask;
uniform float uUseMask;
uniform float uProgress;
uniform float uSeed;
uniform int uMode;
uniform vec2 uDirection;
uniform vec2 uTexel;
uniform float uRadialAmount;
varying vec2 vUv;

${HASH}

vec3 radialBlur(vec2 uv, float amount) {
  vec2 center = vec2(0.5);
  vec3 acc = texture2D(uFrom, uv).rgb;
  float total = 1.0;
  for (int i = 1; i <= 5; i++) {
    float fi = float(i);
    vec2 off = (uv - center) * amount * fi * 0.18;
    acc += texture2D(uFrom, uv + off).rgb;
    total += 1.0;
  }
  return acc / total;
}

void main() {
  vec3 fromC = texture2D(uFrom, vUv).rgb;
  vec3 toC = texture2D(uTo, vUv).rgb;
  float t = clamp(uProgress, 0.0, 1.0);
  vec3 outColor;

  if (uMode == 0) {
    outColor = mix(fromC, toC, smoothstep(0.0, 1.0, t));
  } else if (uMode == 1) {
    vec3 blurred = radialBlur(vUv, uRadialAmount);
    float half1 = smoothstep(0.0, 0.5, t);
    float half2 = smoothstep(0.5, 1.0, t);
    outColor = mix(blurred, toC, half1);
    outColor = mix(outColor, toC, half2 * 0.4);
  } else if (uMode == 2) {
    // luma / mask 擦除：默认沿 uDirection 推进
    float wipe;
    if (uDirection.y > 0.5) wipe = vUv.y;
    else if (uDirection.y < -0.5) wipe = 1.0 - vUv.y;
    else if (uDirection.x > 0.5) wipe = vUv.x;
    else wipe = 1.0 - vUv.x;
    float edge = wipe - t * 1.2 + 0.1;
    float m = uUseMask > 0.5 ? texture2D(uMask, vUv).r : vnoise(vUv * 6.0 + uSeed) * 0.35 + wipe * 0.65;
    float a = smoothstep(0.0, 0.12, m - (1.0 - t) * 1.2 + 0.85);
    outColor = mix(fromC, toC, clamp(a, 0.0, 1.0));
    // 边缘亮线
    float line = smoothstep(0.10, 0.0, abs(m - (t * 1.2 - 0.1)));
    outColor += line * 0.16 * (1.0 - t) * vec3(1.0);
  } else if (uMode == 3) {
    float n = vnoise(vUv * 14.0 + uSeed * 3.1);
    float th = n * 0.65 + 0.35;
    float a = smoothstep(th - 0.16, th + 0.16, t * 1.25);
    outColor = mix(fromC, toC, a);
  } else {
    // push：from 被"推走"，to 从反方向推入
    vec2 dir = normalize(uDirection + vec2(0.0001));
    float push = smoothstep(0.0, 1.0, t);
    vec3 pushFrom = texture2D(uFrom, vUv - dir * push * 0.35).rgb;
    vec3 pushTo = texture2D(uTo, vUv + dir * (1.0 - push) * 0.35).rgb;
    outColor = mix(pushFrom, pushTo, push);
  }

  gl_FragColor = vec4(outColor, 1.0);
}
`

/** 深度视差层：顶点按深度贴图位移 + UV 视差。 */
export const PARALLAX_VERT = /* glsl */ `
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform float uParallax;
uniform float uDepthScale;
uniform vec3 uCameraPos;
uniform vec3 uPlaneCenter;
varying vec2 vUv;
varying float vDepth;

void main() {
  vUv = uv;
  float d = texture2D(uDepth, uv).r;
  // 深度图约定：近处亮（1），远处暗（0）
  float depth = mix(0.5, d, uHasDepth);
  vDepth = depth;
  vec3 pos = position;
  // 顶点位移：越近越"凸"向相机
  pos.z += (depth - 0.5) * uDepthScale * uParallax;
  vec4 world = modelMatrix * vec4(pos, 1.0);
  // UV 视差：相机横向移动时同一深度的采样点位移不同 → 层间错动
  vec3 offset = (uCameraPos - uPlaneCenter);
  float shift = uParallax * 0.06 * (1.0 - depth);
  world.xy += vec2(-offset.x, offset.y) * shift;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

export const PARALLAX_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uMatte;
uniform float uHasMatte;
uniform float uOpacity;
uniform vec3 uTint;
uniform float uTintAmount;
uniform float uEdgeBoost;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;

${HASH}

void main() {
  // 按深度做极轻微的 UV 偏移，避免"纸片感"，但保持画面整体不抖
  vec2 uv = vUv + (vDepth - 0.5) * 0.004;
  vec3 color = texture2D(uMap, uv).rgb;
  float alpha = texture2D(uMap, uv).a;
  if (uHasMatte > 0.5) {
    alpha *= texture2D(uMatte, uv).r;
  }
  // 注意：这里**不能**用深度做 alpha 淡出。曾经写成
  //   alpha *= smoothstep(0.0, 0.35, vDepth + 0.25);
  // 结果是"近处越亮越透明"，整层变成一块半透明的雾面板（画面发糊的头号元凶）。
  // 图层边界交给 preset 的过量取景（plateFrame * 1.25）解决，不靠 shader 淡边。

  // 轻量轮廓增强：邻域梯度拉高，用于"风格化边缘"
  if (uEdgeBoost > 0.0001) {
    float gx = length(texture2D(uMap, uv + vec2(0.0025, 0.0)).rgb - texture2D(uMap, uv - vec2(0.0025, 0.0)).rgb);
    float gy = length(texture2D(uMap, uv + vec2(0.0, 0.0025)).rgb - texture2D(uMap, uv - vec2(0.0, 0.0025)).rgb);
    float edge = smoothstep(0.04, 0.28, gx + gy);
    // 只在很细的边缘上轻微提亮，幅度再压 0.35 —— 暴力轮廓增强是"白边/毛刺"的元凶
    color = mix(color, color * 0.62 + vec3(0.95, 0.96, 1.0) * 0.38, clamp(edge * uEdgeBoost * 0.35, 0.0, 1.0));
  }

  color = mix(color, uTint, uTintAmount);
  gl_FragColor = vec4(color, alpha * uOpacity);
}
`

/** 实例化空间场：带自定义大气雾（按深度 mix 雾色）。 */
export const FIELD_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmplitude;
uniform float uPhase;
attribute vec3 aSeed;
varying float vDepth;
varying vec3 vNormalW;
varying float vSeed;

void main() {
  vSeed = aSeed.x;
  vec3 pos = position;
  // 缓慢呼吸位移（确定性：由 seed + uTime 决定）
  pos.x += sin(uTime * 0.7 + aSeed.x * 6.283) * uAmplitude * 0.35;
  pos.y += cos(uTime * 0.53 + aSeed.y * 6.283) * uAmplitude;
  pos.z += sin(uTime * 0.31 + aSeed.z * 6.283) * uAmplitude * 0.5;

  vec4 world = modelMatrix * instanceMatrix * vec4(pos, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec4 viewPos = viewMatrix * world;
  vDepth = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`

export const FIELD_FRAG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uBaseColor;
uniform vec3 uAccentColor;
uniform float uFogPower;
uniform vec3 uLightDir;
uniform float uRim;
varying float vDepth;
varying vec3 vNormalW;
varying float vSeed;

void main() {
  vec3 n = normalize(vNormalW);
  float lambert = max(dot(n, normalize(uLightDir)), 0.0);
  float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 2.0) * uRim;
  vec3 color = mix(uBaseColor, uAccentColor, clamp(vSeed, 0.0, 1.0));
  color *= 0.35 + lambert * 0.9 + rim;

  // 大气透视：越远越接近雾色（指数项给"空气厚度"）
  float fog = clamp((vDepth - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);
  fog = pow(fog, uFogPower);
  color = mix(color, uFogColor, fog);
  gl_FragColor = vec4(color, 1.0);
}
`

/** 视频平面：混合模式 + 可选 chroma key。 */
export const VIDEO_PLANE_FRAG = /* glsl */ `
uniform sampler2D uVideo;
uniform float uOpacity;
uniform int uBlend;
uniform float uUseChroma;
uniform vec3 uChromaColor;
uniform float uChromaSimilarity;
uniform float uChromaSmoothness;
uniform float uLumaBoost;
uniform float uFeather;
varying vec2 vUv;

void main() {
  vec4 raw = texture2D(uVideo, vec2(vUv.x, 1.0 - vUv.y));
  vec3 color = raw.rgb;
  float alpha = raw.a;

  // 羽化：视频平面不能像贴纸一样硬切在 3D 空间里。
  // uFeather 是羽化宽度（0.08~0.35 对应 UV 的百分比），中心 1、边缘 0。
  if (uFeather > 0.001) {
    vec2 d = abs(vUv - 0.5) * 2.0;
    float edge = max(d.x, d.y);
    float falloff = 1.0 - smoothstep(1.0 - uFeather, 1.0, edge);
    alpha *= falloff;
  }

  if (uUseChroma > 0.5) {
    float dist = distance(color, uChromaColor);
    float mask = smoothstep(uChromaSimilarity, uChromaSimilarity + uChromaSmoothness + 0.001, dist);
    alpha *= mask;
  }

  if (uBlend == 0) {           // normal
    gl_FragColor = vec4(color, alpha * uOpacity);
  } else if (uBlend == 1) {    // additive
    gl_FragColor = vec4(color * alpha * uOpacity, alpha * uOpacity);
  } else if (uBlend == 2) {    // multiply
    gl_FragColor = vec4(mix(vec3(1.0), color, alpha) * uOpacity + (1.0 - uOpacity), 1.0);
  } else {                     // luma key
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float a = smoothstep(0.02, 0.42, lum) * alpha * uOpacity;
    color = color / max(lum, 0.001) * (1.0 + uLumaBoost);
    gl_FragColor = vec4(color, a);
  }
}
`
