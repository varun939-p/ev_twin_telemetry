"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Pill } from "@/components/ui/Pill";
import type { SwapStation } from "@/lib/fleet";
import { simulateSite, type InboundSeed, type PackSeed } from "@/lib/site-model";

/** Dependency-free WebGL scene. It keeps the repository's protected package
 * manifest untouched while still providing real perspective, depth testing,
 * orbit controls, animated vehicle motion, wheel geometry, a gantry, battery
 * racks and illuminated charge ports. */
const VERTEX = `attribute vec3 a_position; attribute vec3 a_color; uniform mat4 u_matrix; varying vec3 v_color; void main(){gl_Position=u_matrix*vec4(a_position,1.0);v_color=a_color;}`;
const FRAGMENT = `precision mediump float; varying vec3 v_color; uniform float u_brightness; void main(){gl_FragColor=vec4(v_color*u_brightness,1.0);}`;

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function perspective(fov: number, aspect: number, near: number, far: number) { const f = 1 / Math.tan(fov / 2); return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]; }
function lookAt(eye: V3, target: V3, up: V3) { const z = norm(sub(eye, target)); const x = norm(cross(up, z)); const y = cross(z, x); return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]; }
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const n = Math.hypot(...a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
function multiply(a: number[], b: number[]) { const out = Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return out; }

function pushBox(out: number[], color: V3, center: V3, size: V3, rotation = 0) {
  const [w, h, d] = size; const verts: V3[] = [[-w, -h, -d], [w, -h, -d], [w, h, -d], [-w, h, -d], [-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d]];
  const faces = [[0, 1, 2, 0, 2, 3], [4, 6, 5, 4, 7, 6], [0, 4, 5, 0, 5, 1], [3, 2, 6, 3, 6, 7], [1, 5, 6, 1, 6, 2], [0, 3, 7, 0, 7, 4]];
  const shades = [0.8, 1.15, 0.65, 1.0, 0.9, 0.72]; const c = Math.cos(rotation), s = Math.sin(rotation);
  for (let f = 0; f < faces.length; f++) for (const index of faces[f]) { const p = verts[index]; const x = p[0] * c - p[2] * s + center[0]; const z = p[0] * s + p[2] * c + center[2]; out.push(x, p[1] + center[1], z, color[0] * shades[f], color[1] * shades[f], color[2] * shades[f]); }
}
function pushCylinder(out: number[], center: V3, radius: number, width: number, rotation: number, color: V3) {
  const segments = 16; for (let i = 0; i < segments; i++) { const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments; for (const side of [-1, 1]) { const z = side * width; out.push(center[0] + Math.cos(a) * radius * Math.cos(rotation) - Math.sin(a) * radius * Math.sin(rotation), center[1] + Math.sin(a) * radius, center[2] + Math.cos(a) * radius * Math.sin(rotation) + Math.sin(a) * radius * Math.cos(rotation) + z, ...color); out.push(center[0] + Math.cos(b) * radius * Math.cos(rotation) - Math.sin(b) * radius * Math.sin(rotation), center[1] + Math.sin(b) * radius, center[2] + Math.cos(b) * radius * Math.sin(rotation) + Math.sin(b) * radius * Math.cos(rotation) + z, ...color); } }
}
function pushLine(out: number[], a: V3, b: V3, color: V3, width = 0.04) { const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; const len = Math.hypot(b[0] - a[0], b[2] - a[2]) / 2; pushBox(out, color, mid, [len, width, width], Math.atan2(b[2] - a[2], b[0] - a[0])); }

export default function RealFacilityScene({ packs, inbound, station }: { packs: PackSeed[]; inbound: InboundSeed[]; station: SwapStation | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null); const router = useRouter(); const [paused, setPaused] = useState(false); const [tick, setTick] = useState(0); const camera = useRef({ yaw: -0.72, pitch: 0.62, distance: 15 });
  useEffect(() => { if (paused) return; const id = window.setInterval(() => setTick((value) => value + 1), 1000); return () => window.clearInterval(id); }, [paused]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return; const gl = canvas.getContext("webgl", { antialias: true, alpha: true }); if (!gl) return;
    const compile = (type: number, source: string) => { const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); return shader; };
    const program = gl.createProgram()!; gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT)); gl.linkProgram(program); gl.useProgram(program);
    const position = gl.getAttribLocation(program, "a_position"), color = gl.getAttribLocation(program, "a_color"), matrix = gl.getUniformLocation(program, "u_matrix"), brightness = gl.getUniformLocation(program, "u_brightness");
    let frame = 0; const scene = simulateSite(tick, packs, inbound, station); const down = { x: 0, y: 0, active: false };
    const onDown = (event: PointerEvent) => { down.active = true; down.x = event.clientX; down.y = event.clientY; canvas.setPointerCapture(event.pointerId); }; const onMove = (event: PointerEvent) => { if (!down.active) return; camera.current.yaw += (event.clientX - down.x) * 0.008; camera.current.pitch = Math.max(0.22, Math.min(1.2, camera.current.pitch + (event.clientY - down.y) * 0.006)); down.x = event.clientX; down.y = event.clientY; }; const onUp = () => { down.active = false; }; const onWheel = (event: WheelEvent) => { event.preventDefault(); camera.current.distance = Math.max(8, Math.min(24, camera.current.distance + event.deltaY * 0.012)); }; const onClick = (event: MouseEvent) => { const rect = canvas.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width; if (x < 0.28) router.push("/digital-twin/truck-telemetry"); else if (x > 0.38 && x < 0.7) router.push("/digital-twin/battery-tracking"); };
    canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp); canvas.addEventListener("wheel", onWheel, { passive: false }); canvas.addEventListener("click", onClick);
    const render = () => { const dpr = Math.min(window.devicePixelRatio || 1, 2); const width = canvas.clientWidth * dpr, height = canvas.clientHeight * dpr; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; } gl.viewport(0, 0, width, height); gl.clearColor(0.035, 0.06, 0.1, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const cam = camera.current; const eye: V3 = [Math.sin(cam.yaw) * Math.cos(cam.pitch) * cam.distance, Math.sin(cam.pitch) * cam.distance, Math.cos(cam.yaw) * Math.cos(cam.pitch) * cam.distance]; const matrixValue = multiply(perspective(0.82, width / height, 0.1, 100), lookAt(eye, [0, 0.5, 0], [0, 1, 0])); const data: number[] = [];
      pushBox(data, [0.11, 0.18, 0.28], [0, -0.22, 0], [6.4, 0.12, 4.2]);
      for (let i = -5; i <= 5; i++) pushLine(data, [i, -0.05, -3.4], [i, -0.05, 3.4], [0.12, 0.22, 0.32], 0.012);
      for (let i = -3; i <= 3; i++) pushLine(data, [-5.8, -0.04, i], [5.8, -0.04, i], [0.12, 0.22, 0.32], 0.012);
      pushBox(data, [0.18, 0.28, 0.45], [1.8, 1.35, 0], [2.3, 1.35, 1.75]); pushBox(data, [0.08, 0.14, 0.22], [1.8, 2.9, 0], [2.45, 0.08, 1.85]);
      for (let i = 0; i < 4; i++) { const z = -1.25 + i * 0.84; const soc = scene.bays[i]?.soc ?? 0; pushBox(data, [0.08, 0.35 + soc / 240, 0.3], [1.8, 0.2, z], [1.25, 0.22, 0.26]); pushBox(data, [0.06, 0.08, 0.12], [0.5, 0.34, z], [0.12, 0.35, 0.16]); }
      pushBox(data, [0.28, 0.25, 0.1], [-3.8, 0.9, 0], [0.7, 0.9, 1.5]); pushBox(data, [0.35, 0.24, 0.08], [-3.8, 2.05, 0], [0.82, 0.05, 1.6]); pushLine(data, [-4.6, 2.0, 0], [4.1, 2.0, 0], [0.3, 0.42, 0.58], 0.06);
      const t = Math.max(0.02, Math.min(0.96, scene.dock.roadT)); const truckX = -5.2 + t * 10.4; const truckZ = -2.25 + Math.sin(t * Math.PI) * 0.35; const heading = Math.atan2(0.35 * Math.PI * Math.cos(t * Math.PI), 10.4); const truck: V3 = [truckX, 0.65, truckZ]; pushBox(data, scene.dock.phase === "clear" ? [0.18, 0.3, 0.5] : [0.12, 0.44, 0.72], truck, [1.25, 0.62, 0.72], heading); pushBox(data, [0.28, 0.48, 0.7], add(truck, [Math.cos(heading) * 1.62, 0.22, Math.sin(heading) * 1.62]), [0.48, 0.45, 0.7], heading); for (const axle of [-0.8, 0.25, 1.1]) for (const side of [-0.82, 0.82]) pushCylinder(data, add(truck, [Math.cos(heading) * axle, -0.55, Math.sin(heading) * axle + side]), 0.35, 0.12, heading, [0.025, 0.03, 0.04]);
      if (scene.dock.phase === "swapping") { const craneX = -2.2 + scene.dock.craneT * 3.9; pushBox(data, [0.55, 0.18, 0.12], [craneX, 1.92, 0], [0.4, 0.16, 0.5]); pushBox(data, [0.24, 0.32, 0.08], [craneX, 0.85 + scene.dock.hoistT * 0.8, 0], [0.65, 0.1, 0.45]); }
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(color); gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 24, 12); gl.uniformMatrix4fv(matrix, false, new Float32Array(matrixValue)); gl.uniform1f(brightness, 1.0); gl.drawArrays(gl.TRIANGLES, 0, data.length / 6); gl.deleteBuffer(buffer); frame = requestAnimationFrame(render); };
    render(); return () => { cancelAnimationFrame(frame); canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("wheel", onWheel); canvas.removeEventListener("click", onClick); gl.deleteProgram(program); };
  }, [tick, packs, inbound, station, router]);
  return <div className="canvas-dark relative overflow-hidden rounded-xl border border-line bg-[radial-gradient(circle_at_55%_8%,rgba(111,159,216,.28),transparent_38%),linear-gradient(135deg,#142235,#10151d)]"><canvas ref={canvasRef} className="block h-[430px] w-full cursor-grab active:cursor-grabbing" aria-label="Interactive three dimensional electric truck battery swap station" /><div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between"><div><Pill tone="info" dot>Live facility model</Pill><p className="mt-2 max-w-xs text-[11px] text-white/65">Drag to orbit · scroll to zoom · click truck or station</p></div><button type="button" onClick={() => setPaused((value) => !value)} className="pointer-events-auto cursor-pointer rounded-lg border border-white/15 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-white/80 backdrop-blur hover:bg-black/35">{paused ? "Resume motion" : "Pause motion"}</button></div><div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[11px] text-white/70 backdrop-blur">Truck route · wheel steering · charge port · crane lift · battery rack</div></div>;
}
