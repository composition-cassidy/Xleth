export const BACKDROP_FX_MAX_RIPPLES = 8
export const BACKDROP_FX_MAX_RECTS = 24

export const BACKDROP_FX_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

export const BACKDROP_FX_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uImage;
uniform bool uHasImage;
uniform int uPreset;
uniform float uIntensity;
uniform vec4 uIntensityChannels;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uCursor;
uniform int uRippleCount;
uniform vec4 uRipples[${BACKDROP_FX_MAX_RIPPLES}];
uniform int uRectCount;
uniform vec4 uRects[${BACKDROP_FX_MAX_RECTS}];
uniform vec3 uTint;
uniform vec3 uSurface;
uniform vec3 uAccent;
uniform bool uReactToCursor;
uniform bool uReactToWindows;
uniform bool uReactToClicks;
uniform bool uStudioGridOverlay;

in vec2 vUv;
out vec4 outColor;

const int PRESET_STATIC_ENHANCED = 0;
const int PRESET_SUBTLE_GLASS = 1;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

vec3 sampleBackdrop(vec2 uv) {
  if (uHasImage) {
    return texture(uImage, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  }
  float wash = smoothstep(0.0, 1.0, uv.y);
  return mix(uSurface * 0.78, uTint * 0.55 + uSurface * 0.45, wash);
}

void main() {
  vec2 imageUv = vUv;
  vec2 screenUv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 pixel = screenUv * uResolution;
  float intensity = clamp(uIntensity, 0.0, 1.0);
  float displacementPower = clamp(uIntensityChannels.x, 0.0, 3.0);
  float glowPower = clamp(uIntensityChannels.y, 0.0, 1.5);
  float ripplePower = clamp(uIntensityChannels.z, 0.0, 2.6);
  float windowPower = clamp(uIntensityChannels.w, 0.0, 2.0);
  float rectPressure = 0.0;
  bool isReactivePreset = uPreset == PRESET_SUBTLE_GLASS;

  if (isReactivePreset && uReactToWindows) {
    for (int i = 0; i < ${BACKDROP_FX_MAX_RECTS}; ++i) {
      if (i >= uRectCount) break;
      vec4 r = uRects[i];
      vec2 center = r.xy + r.zw * 0.5;
      float edge = abs(sdBox(pixel - center, r.zw * 0.5));
      rectPressure += 1.0 - smoothstep(0.0, 46.0, edge);
    }
    rectPressure = clamp(rectPressure, 0.0, 1.0);
  }

  vec2 distortion = vec2(0.0);
  float light = 0.0;
  if (isReactivePreset && uReactToCursor && uCursor.x >= 0.0) {
    vec2 c = uCursor / max(uResolution, vec2(1.0));
    vec2 delta = screenUv - c;
    float d = length(delta);
    float field = 1.0 - smoothstep(0.0, 0.22, d);
    float vortex = sin((delta.x - delta.y) * 18.0 + d * 10.0) * 0.0018 * displacementPower;
    distortion += normalize(delta + vec2(0.0001)) * field * 0.006 * displacementPower;
    distortion += vec2(-delta.y, delta.x) * field * vortex;
    light += field * 0.16 * glowPower;
  }

  float rippleLight = 0.0;
  float ripplePulse = 0.0;
  if (isReactivePreset && uReactToClicks) {
    for (int i = 0; i < ${BACKDROP_FX_MAX_RIPPLES}; ++i) {
      if (i >= uRippleCount) break;
      vec4 rp = uRipples[i];
      float age = clamp((uTime - rp.z) / max(rp.w, 0.001), 0.0, 1.0);
      float radius = mix(8.0, 138.0, age);
      float d = abs(length(pixel - rp.xy) - radius);
      float ring = (1.0 - smoothstep(0.0, 18.0, d)) * (1.0 - age);
      distortion += normalize(pixel - rp.xy + vec2(0.001)) / max(uResolution, vec2(1.0)) * ring * 3.0 * ripplePower;
      rippleLight += ring * 0.20 * glowPower;
      ripplePulse += ring * (1.0 - age);
    }
  }

  distortion += vec2(rectPressure * -0.0025, rectPressure * 0.002) * windowPower;
  vec3 color = sampleBackdrop(imageUv + vec2(distortion.x, -distortion.y));

  float vignette = smoothstep(0.9, 0.22, length(screenUv - 0.5));
  color = mix(color * (0.90 - rectPressure * 0.045 * windowPower), color, vignette);
  color = mix(color, uTint, 0.055 * intensity);

  if (isReactivePreset && uStudioGridOverlay) {
    float perspective = mix(0.74, 1.18, screenUv.y);
    vec2 gridUv = vec2((screenUv.x - 0.5) * perspective + 0.5, pow(screenUv.y, 1.10));
    gridUv += distortion * vec2(8.0, 6.0);
    vec2 grid = gridUv * uResolution / 34.0;
    vec2 cell = abs(fract(grid) - 0.5);
    vec2 fw = max(fwidth(grid), vec2(0.001));
    float lineX = 1.0 - smoothstep(0.0, fw.x * 1.25 + 0.018, cell.x);
    float lineY = 1.0 - smoothstep(0.0, fw.y * 1.25 + 0.018, cell.y);
    vec2 majorCell = abs(fract(grid / 4.0) - 0.5);
    float majorX = 1.0 - smoothstep(0.0, fw.x * 0.75 + 0.010, majorCell.x);
    float majorY = 1.0 - smoothstep(0.0, fw.y * 0.75 + 0.010, majorCell.y);
    float gridLine = clamp(max(lineX, lineY) * 0.55 + max(majorX, majorY) * 0.45, 0.0, 1.0);
    float gridFade = smoothstep(0.02, 0.28, screenUv.y) * (1.0 - smoothstep(0.96, 1.0, screenUv.y));
    float gridAlpha = (0.024 + 0.034 * intensity + 0.038 * clamp(ripplePulse, 0.0, 1.0)) * gridFade;
    gridAlpha *= 1.0 - rectPressure * 0.22 * windowPower;
    vec3 gridColor = mix(uTint, uAccent, 0.42);
    color = mix(color, gridColor, gridLine * gridAlpha);
  }

  float grain = hash(floor(pixel * 0.55) + vec2(uTime * 0.0)) - 0.5;
  color += grain * 0.018 * intensity;
  color += uAccent * (light + rippleLight + rectPressure * 0.035 * windowPower);

  outColor = vec4(clamp(color, 0.0, 1.0), uHasImage ? 1.0 : 0.72);
}
`
