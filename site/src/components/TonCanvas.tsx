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
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export default function TonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function draw() {
      const w = canvas!.width = window.innerWidth;
      const h = canvas!.height = window.innerHeight;
      const scale = Math.min(w, h) * 0.28;
      const cx = w * 0.75;
      const cy = h * 0.45;
      const spacing = 8;
      const r = 1.5;

      ctx!.clearRect(0, 0, w, h);
      ctx!.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx!.beginPath();

      for (let px = cx - scale; px <= cx + scale; px += spacing) {
        for (let py = cy - scale; py <= cy + scale; py += spacing) {
          const nx = (px - cx) / scale;
          const ny = (py - cy) / scale;
          if (pip(nx, ny, outer) && !pip(nx, ny, holeL) && !pip(nx, ny, holeR)) {
            ctx!.moveTo(px + r, py);
            ctx!.arc(px, py, r, 0, Math.PI * 2);
          }
        }
      }
      ctx!.fill();
    }

    draw();
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 right-0 w-full h-screen -z-1 opacity-60 pointer-events-none hidden sm:block"
    />
  );
}
