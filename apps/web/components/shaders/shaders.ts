/**
 * Fragment shaders for the live backgrounds. Hand-written GLSL ES 3.00 (WebGL2), no libraries.
 *
 * The site is light, so these are light: soft, airy fields on warm paper (#FAFAF9, the page background), with
 * ember, persimmon and gold as tints rather than as darkness. Every colour stays bright enough that the
 * page's ink text keeps AA contrast on top of it (the bands also darken their secondary text a little).
 *
 * Every animated term is a sine or cosine of `u_phase` at an integer multiple, so the picture repeats
 * exactly every loop and never visibly jumps.
 */

export type ShaderVariant = 'orbs' | 'silk' | 'gold';

const HEADER = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_res;        // canvas size in device pixels
uniform float u_phase;     // 0..2*pi, one full turn per loop
uniform float u_grain;     // steps a few times per second, drives the film grain
uniform float u_intensity; // overall strength, 0..1 (0 is plain paper)
uniform vec2 u_offset;     // composition shift in screen-height units (x right, y up)
out vec4 outColor;

// The page background, so a band's edges melt into the page.
const vec3 PAPER = vec3(0.980, 0.980, 0.976);

// Hash without sin(): stable on every GPU.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Fine film grain. Fades out on pure paper so empty areas stay clean.
vec3 grain(vec3 col, vec2 frag, float amount) {
  float g = hash12(frag + u_grain * vec2(37.17, 91.71)) - 0.5;
  float tint = clamp(distance(col, PAPER) * 3.0, 0.0, 1.0);
  return col + g * amount * (0.25 + 0.75 * tint);
}
`;

/** Three slow pools of warm light drifting in from the bottom edge, domain-warped, with fine grain. */
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

  vec2 c1 = vec2(0.18, 0.08) + 0.05 * vec2(sin(u_phase), cos(u_phase));
  vec2 c2 = vec2(0.82, 0.14) + 0.05 * vec2(cos(u_phase + 1.2), sin(2.0 * u_phase));
  vec2 c3 = vec2(0.50, -0.04) + 0.04 * vec2(sin(2.0 * u_phase + 2.0), cos(u_phase + 0.4));

  float d1 = length((q - c1) * A);
  float d2 = length((q - c2) * A);
  float d3 = length((q - c3) * A);
  float o1 = exp(-d1 * d1 / 0.052);
  float o2 = exp(-d2 * d2 / 0.064);
  float o3 = exp(-d3 * d3 / 0.115);

  // Tints, each mixed over the paper. Deeper toward the centre of an orb, never darker than a soft ember.
  vec3 apricot = vec3(0.992, 0.800, 0.668);
  vec3 persimmon = vec3(0.969, 0.545, 0.337);
  vec3 gold = vec3(0.992, 0.812, 0.455);
  vec3 cream = vec3(1.000, 0.945, 0.860);

  vec3 col = PAPER;
  col = mix(col, apricot, clamp(o3 * 0.95, 0.0, 1.0));
  col = mix(col, mix(apricot, persimmon, smoothstep(0.25, 1.0, o1)), clamp(o1 * 1.1, 0.0, 1.0));
  col = mix(col, mix(vec3(0.996, 0.870, 0.560), gold, smoothstep(0.25, 1.0, o2)), clamp(o2 * 1.05, 0.0, 1.0));
  // A luminous cream bloom in the heart of each orb.
  col = mix(col, cream, pow(o1, 4.0) * 0.5);
  col = mix(col, cream, pow(o2, 4.0) * 0.55);

  // A faint warm haze far up on the right keeps the top from going flat.
  vec2 hz = (uv - vec2(0.9, 1.0)) * A;
  col = mix(col, vec3(0.992, 0.905, 0.820), 0.55 * exp(-dot(hz, hz) / 0.5));

  col = mix(PAPER, col, u_intensity);

  // Edges melt into the page.
  vec2 vc = (uv - 0.5) * vec2(1.0, 1.15);
  col = mix(PAPER, col, mix(0.55, 1.0, smoothstep(1.05, 0.2, length(vc * vec2(aspect * 0.6, 1.0)))));

  col = grain(col, frag, 0.05);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** A ribbon of many thin parallel lines, etched in persimmon, deepening to ember at its edges. */
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

  vec3 gold = vec3(0.945, 0.690, 0.275);
  vec3 hot = vec3(0.945, 0.455, 0.215);
  vec3 ember = vec3(0.780, 0.255, 0.105);
  vec3 c = mix(gold, hot, smoothstep(0.0, 0.45, ad));
  c = mix(c, ember, smoothstep(0.4, 0.95, ad));

  float lit = 0.5 + 0.5 * sin(x * 1.6 - u_phase + 0.5);       // light travelling along the ribbon

  vec3 col = PAPER;
  // A soft peach glow under the ribbon.
  col = mix(col, vec3(0.992, 0.855, 0.730), exp(-d * d * 0.9) * (0.35 + 0.65 * lit) * 0.75 * u_intensity);
  // The etched lines. Where the light catches the silk they thin out toward the paper.
  col = mix(col, c, line * inside * (0.5 + 0.5 * lit) * 0.9 * u_intensity);

  col = grain(col, frag, 0.04);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** A slow champagne sheen with one bright horizon, like light running along a leaf of gold. */
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

  vec3 champagne = vec3(0.992, 0.890, 0.690);
  vec3 gold = vec3(0.985, 0.790, 0.420);
  vec3 white = vec3(1.0, 0.985, 0.940);

  vec3 col = PAPER;
  col = mix(col, champagne, wide * (0.45 + 0.55 * field) * 0.85);
  col = mix(col, gold, mid * 0.6);
  col = mix(col, white, core * 0.9);

  // Below the horizon the sheen settles into a warm apricot pool, deepest to the lower right.
  float pool = smoothstep(0.70, 0.05, uv.y);
  vec3 settle = mix(vec3(0.990, 0.880, 0.720), vec3(0.975, 0.700, 0.470), smoothstep(0.0, 1.0, uv.x * 0.8 + (0.5 - uv.y)));
  col = mix(col, settle, pool * 0.75);

  col = mix(PAPER, col, u_intensity);
  col = grain(col, frag, 0.05);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const SHADERS: Record<ShaderVariant, { fragment: string; loopSeconds: number; staticPhase: number }> = {
  orbs: { fragment: ORBS, loopSeconds: 12, staticPhase: 0.9 },
  silk: { fragment: SILK, loopSeconds: 10, staticPhase: 1.7 },
  gold: { fragment: GOLD, loopSeconds: 10, staticPhase: 0.6 },
};
