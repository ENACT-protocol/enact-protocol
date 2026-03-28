'use client';
import { useEffect, useRef } from 'react';

const outer: [number, number][] = [
  [-0.65, -0.79], [0.65, -0.79],
  [0.750, -0.726], [0.834, -0.684], [0.890, -0.623], [0.91, -0.55],
  [0.91, -0.49],
  [0.00, 0.80],
  [-0.91, -0.49],
  [-0.91, -0.55], [-0.890, -0.623], [-0.834, -0.684], [-0.750, -0.726],
];
const holeL: [number, number][] = [
  [-0.667, -0.633], [-0.115, -0.633],
  [-0.115, 0.42], [-0.732, -0.532],
];
const holeR: [number, number][] = [
  [0.115, -0.633], [0.667, -0.633],
  [0.732, -0.532], [0.115, 0.42],
];

function pip(px: number, py: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    const xi = poly[i][0], xj = poly[j][0];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function computeDots(cx: number, cy: number, scale: number, spacing: number) {
  const dots: { x: number; y: number; nx: number; ny: number }[] = [];
  for (let px = cx - scale; px <= cx + scale; px += spacing) {
    for (let py = cy - scale; py <= cy + scale; py += spacing) {
      const nx = (px - cx) / scale;
      const ny = (py - cy) / scale;
      if (pip(nx, ny, outer) && !pip(nx, ny, holeL) && !pip(nx, ny, holeR)) {
        dots.push({ x: px, y: py, nx, ny });
      }
    }
  }
  return dots;
}

export default function TonCanvasV2({ variant = 'A' }: { variant?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let dots: { x: number; y: number; nx: number; ny: number }[] = [];
    let cx = 0, cy = 0, scale = 0;

    function resize() {
      const w = canvas!.width = window.innerWidth;
      const h = canvas!.height = window.innerHeight;
      scale = Math.min(w, h) * 0.28;
      cx = w * 0.75;
      cy = h * 0.45;
      dots = computeDots(cx, cy, scale, 8);
    }

    function draw(time: number) {
      const w = canvas!.width;
      const h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);
      const t = time / 1000;

      for (const dot of dots) {
        const dist = Math.sqrt(dot.nx * dot.nx + dot.ny * dot.ny);
        const wave = Math.sin(dist * 5 - t * 1.8) * 0.5 + 0.5;

        const rr = Math.round(wave * 20);
        const gg = Math.round(120 + wave * 60);
        const bb = Math.round(220 + wave * 35);
        const alpha = 0.75 + wave * 0.2;
        const dotR = 1.4 + wave * 0.5;

        ctx!.fillStyle = `rgba(${rr}, ${gg}, ${bb}, ${alpha})`;
        ctx!.beginPath();
        ctx!.arc(dot.x, dot.y, dotR, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Sparks
      for (let i = 0; i < 4; i++) {
        const seed = Math.floor(t * 5 + i * 97) % dots.length;
        const spark = dots[seed];
        const sparkAlpha = (Math.sin(t * 10 + i * 4) * 0.5 + 0.5) * 0.5;
        if (sparkAlpha > 0.25) {
          ctx!.fillStyle = `rgba(120, 210, 255, ${sparkAlpha})`;
          ctx!.beginPath();
          ctx!.arc(spark.x, spark.y, 2.5, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      animId = requestAnimationFrame(draw);
    }

    resize();
    animId = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 right-0 w-full h-screen -z-1 opacity-60 pointer-events-none hidden sm:block"
    />
  );
}
