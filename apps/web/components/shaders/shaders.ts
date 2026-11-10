/**
 * Fragment shaders for the live backgrounds. Hand-written GLSL ES 3.00 (WebGL2), no libraries.
 *
 * Every animated term is a sine or cosine of `u_phase` at an integer multiple, so the picture repeats
 * exactly every loop and never visibly jumps. Colours stay in one warm family (persimmon, gold, cream)
 * on the near-black of the dark theme (#0C0C0B).
 */

export type ShaderVariant = 'orbs' | 'silk' | 'gold';

const HEADER = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_res;        // canvas size in device pixels
uniform float u_phase;     // 0..2*pi, one full turn per loop
uniform float u_grain;     // steps a few times per second, drives the film grain
uniform float u_intensity; // overall brightness, 0..1
uniform vec2 u_offset;     // composition shift in screen-height units (x right, y up)
out vec4 outColor;

const vec3 INK = vec3(0.047, 0.047, 0.043);

// Hash without sin(): stable on every GPU.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Film grain, strongest in the mid tones like real stock.
vec3 grain(vec3 col, vec2 frag, float amount) {
  float g = hash12(frag + u_grain * vec2(37.17, 91.71)) - 0.5;
  float lum = dot(col, vec3(0.3, 0.59, 0.11));
  float w = 0.06 + smoothstep(0.02, 0.45, lum) * (1.0 - smoothstep(0.75, 1.0, lum));
  return col + g * w * amount;
}
`;

/** Three slow light sources blooming out of the dark, domain-warped, with heavy grain. */
const ORBS = /* glsl */ `${HEADER}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 A = vec2(aspect, 1.0);
  uv -= u_offset;

  // Slow domain warp.
  vec2 w = vec2(
    0.10 * sin(uv.y * 2.3 + u_phase) + 0.05 * sin(uv.y * 5.1 - 2.0 * u_phase + 1.7),
    0.10 * cos(uv.x * aspect * 2.0 - u_phase + 0.8) + 0.05 * cos(uv.x * aspect * 4.3 + 2.0 * u_phase)
  );
  vec2 q = uv + w * 0.55;

  vec2 c1 = vec2(0.18, 0.10) + 0.05 * vec2(sin(u_phase), cos(u_phase));
  vec2 c2 = vec2(0.82, 0.16) + 0.05 * vec2(cos(u_phase + 1.2), sin(2.0 * u_phase));
  vec2 c3 = vec2(0.50, -0.02) + 0.04 * vec2(sin(2.0 * u_phase + 2.0), cos(u_phase + 0.4));

  float d1 = length((q - c1) * A);
  float d2 = length((q - c2) * A);
  float d3 = length((q - c3) * A);
  float o1 = exp(-d1 * d1 / 0.050);
  float o2 = exp(-d2 * d2 / 0.062);
  float o3 = exp(-d3 * d3 / 0.100);

  vec3 col = INK;
  col += vec3(0.78, 0.28, 0.11) * o1 * 0.95;     // persimmon
  col += vec3(0.90, 0.66, 0.23) * o2 * 0.80;     // gold
  col += vec3(0.48, 0.13, 0.05) * o3 * 0.85;     // deep ember
  col += vec3(1.00, 0.62, 0.36) * pow(o1, 3.0) * 0.45;
  col += vec3(1.00, 0.86, 0.55) * pow(o2, 3.0) * 0.40;

  // A faint warm haze far up on the right keeps the top from going flat.
  vec2 hz = (uv - vec2(0.9, 1.0)) * A;
  col += vec3(0.16, 0.06, 0.025) * exp(-dot(hz, hz) / 0.55);

  col = 1.0 - exp(-col * 1.55);
  col = mix(INK, col, u_intensity);

  // Vignette, so the edges melt into the page.
  vec2 vc = (uv - 0.5) * vec2(1.0, 1.15);
  col *= mix(0.5, 1.0, smoothstep(1.0, 0.2, length(vc * vec2(aspect * 0.6, 1.0))));

  col = grain(col, frag, 0.16);
  outColor = vec4(max(col, 0.0), 1.0);
}
`;

/** A ribbon of many thin parallel lines, bright cream at its core and burning to ember at the edges. */
const SILK = /* glsl */ `${HEADER}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  float x = (uv.x - 0.5) * aspect - u_offset.x;
  float y = uv.y - 0.5 - u_offset.y;

  // Centre line and width of the ribbon, in screen-height units.
  float cl = 0.10 * sin(x * 1.9 + u_phase)
           + 0.05 * sin(x * 4.3 - 2.0 * u_phase + 1.1)
           + 0.018 * sin(x * 8.7 + 3.0 * u_phase + 0.4)
           + 0.06 * x / max(aspect, 1.0);
  float hw = 0.17 + 0.06 * sin(x * 1.4 - u_phase + 0.9) + 0.025 * sin(x * 3.3 + 2.0 * u_phase);
  hw = max(hw, 0.05);

  float d = (y - cl) / hw;              // -1 .. 1 across the ribbon
  float ad = abs(d);
  float inside = 1.0 - smoothstep(0.9, 1.0, ad);

  // Lines are evenly spaced in angle around a tube, so they crowd together toward the edges.
  float th = asin(clamp(d, -0.999, 0.999));
  float coord = th * (52.0 / 3.14159265) + 0.45 * sin(x * 2.4 + u_phase) + 0.2 * sin(x * 5.0 - u_phase);
  float dist = abs(fract(coord) - 0.5);
  float aa = max(fwidth(coord) * 0.8, 0.0005);
  float width = 0.17;
  float line = 1.0 - smoothstep(width - aa, width + aa, dist);
  // Where lines get denser than pixels, blend to their average instead of aliasing.
  line = mix(line, 2.0 * width, smoothstep(0.3, 0.9, aa * 2.0));

  vec3 cream = vec3(1.0, 0.93, 0.80);
  vec3 hot = vec3(1.0, 0.56, 0.24);
  vec3 ember = vec3(0.80, 0.24, 0.09);
  vec3 deep = vec3(0.28, 0.06, 0.03);
  vec3 c = mix(cream, hot, smoothstep(0.0, 0.5, ad));
  c = mix(c, ember, smoothstep(0.4, 0.88, ad));
  c = mix(c, deep, smoothstep(0.82, 1.0, ad));

  float lit = 0.5 + 0.5 * sin(x * 1.6 - u_phase + 0.5);       // light travelling along the ribbon
  float shade = mix(0.5, 1.0, lit) * (1.0 - 0.3 * smoothstep(0.5, 1.0, ad));

  vec3 col = INK;
  col += c * line * inside * shade * 1.1 * u_intensity;
  col += vec3(0.75, 0.27, 0.09) * exp(-d * d * 0.9) * (0.35 + 0.65 * lit) * 0.10 * u_intensity;

  col = grain(col, frag, 0.12);
  outColor = vec4(max(col, 0.0), 1.0);
}
`;

/** A slow gold sheen with one bright horizon, like light running along a leaf of metal. */
const GOLD = /* glsl */ `${HEADER}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  float xa = uv.x * aspect;

  float y0 = 0.76 + u_offset.y;
  float sway = 0.030 * sin(xa * 1.6 + u_phase) + 0.012 * sin(xa * 4.2 - 2.0 * u_phase + 0.7);
  float dy = uv.y - y0 - sway;

  float core = exp(-pow(dy * 46.0, 2.0));
  float mid = exp(-pow(dy * 13.0, 2.0));
  float wide = exp(-pow(dy * 4.6, 2.0));
  float field = 0.5 + 0.5 * sin(xa * 1.1 - u_phase + uv.y * 1.5);

  vec3 col = INK;
  col += vec3(0.62, 0.43, 0.12) * wide * (0.30 + 0.70 * field) * 0.55;
  col += vec3(0.95, 0.72, 0.30) * mid * 0.34;
  col += vec3(1.00, 0.93, 0.75) * core * 0.62;

  // Below the horizon the metal falls away into shadow, deepest to the lower right.
  float pool = smoothstep(0.70, 0.30, uv.y);
  col *= 1.0 - 0.9 * pool;

  col = mix(INK, col, u_intensity);
  col = grain(col, frag, 0.14);
  outColor = vec4(max(col, 0.0), 1.0);
}
`;

export const SHADERS: Record<ShaderVariant, { fragment: string; loopSeconds: number; staticPhase: number }> = {
  orbs: { fragment: ORBS, loopSeconds: 12, staticPhase: 0.9 },
  silk: { fragment: SILK, loopSeconds: 10, staticPhase: 1.7 },
  gold: { fragment: GOLD, loopSeconds: 10, staticPhase: 0.6 },
};
