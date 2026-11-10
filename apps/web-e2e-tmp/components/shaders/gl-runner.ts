/**
 * A tiny WebGL2 runner for full-screen fragment shaders. No dependencies.
 *
 * - One triangle, no buffers: the vertex shader derives positions from gl_VertexID.
 * - Cheap by construction: the caller sets a small canvas (about half resolution) and a frame cap.
 * - Everything fails quietly. If WebGL2 is missing, a shader does not compile or the context is lost,
 *   createRunner resolves null / calls onLost and the CSS fallback behind the canvas stays visible.
 * - Compiling never blocks the main thread: when the browser offers KHR_parallel_shader_compile the link is
 *   polled instead of awaited (a synchronous status query can stall for hundreds of ms on software GL).
 */

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface RunnerOptions {
  fragment: string;
  loopSeconds: number;
  /** Frames per second ceiling while animating. */
  fps: number;
  intensity: number;
  offset: [number, number];
  /** Called if the browser drops the GL context (GPU reset, tab discarded). */
  onLost?: () => void;
}

export interface Runner {
  /** Resize the drawing buffer (device pixels) and redraw the current frame. */
  resize(width: number, height: number): void;
  /** Draw one frame at an absolute time in seconds. */
  renderAt(seconds: number): void;
  start(): void;
  stop(): void;
  destroy(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export async function createRunner(canvas: HTMLCanvasElement, options: RunnerOptions): Promise<Runner | null> {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, options.fragment);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  if (parallel) {
    const deadline = performance.now() + 4000;
    while (!gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (gl.isContextLost() || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);

  const uRes = gl.getUniformLocation(program, 'u_res');
  const uPhase = gl.getUniformLocation(program, 'u_phase');
  const uGrain = gl.getUniformLocation(program, 'u_grain');
  const uIntensity = gl.getUniformLocation(program, 'u_intensity');
  const uOffset = gl.getUniformLocation(program, 'u_offset');
  gl.uniform1f(uIntensity, options.intensity);
  gl.uniform2f(uOffset, options.offset[0], options.offset[1]);

  const minFrameMs = 1000 / options.fps - 1;
  let raf = 0;
  let running = false;
  let elapsed = 0; // seconds of animation actually played; only advances while running
  let lastNow = 0;
  let lastDraw = 0;
  let destroyed = false;

  const draw = (seconds: number) => {
    if (destroyed || gl.isContextLost()) return;
    const phase = ((seconds % options.loopSeconds) / options.loopSeconds) * Math.PI * 2;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uPhase, phase);
    gl.uniform1f(uGrain, Math.floor(seconds * 12));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const frame = (now: number) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < minFrameMs) return;
    elapsed += Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    lastDraw = now;
    draw(elapsed);
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
    running = false;
    cancelAnimationFrame(raf);
    options.onLost?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  return {
    resize(width, height) {
      canvas.width = Math.max(2, Math.round(width));
      canvas.height = Math.max(2, Math.round(height));
      draw(elapsed);
    },
    renderAt(seconds) {
      elapsed = seconds;
      draw(seconds);
    },
    start() {
      if (running || destroyed) return;
      running = true;
      lastNow = performance.now();
      lastDraw = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    destroy() {
      destroyed = true;
      running = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
