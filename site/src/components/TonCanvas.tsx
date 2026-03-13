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

// Precompute dot positions for the TON logo shape
function computeDots(cx: number, cy: number, scale: number, spacing: number) {
  const dots: { x: number; y: number }[] = [];
  for (let px = cx - scale; px <= cx + scale; px += spacing) {
    for (let py = cy - scale; py <= cy + scale; py += spacing) {
      const nx = (px - cx) / scale;
      const ny = (py - cy) / scale;
      if (pip(nx, ny, outer) && !pip(nx, ny, holeL) && !pip(nx, ny, holeR)) {
        dots.push({ x: px, y: py });
      }
    }
  }
  return dots;
}

export default function TonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let dots: { x: number; y: number }[] = [];
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

      const r = 1.5;
      // Shimmer: a diagonal glint band that sweeps across the logo
      const period = 4000; // ms for one full sweep
      const t = (time % period) / period; // 0..1
      // Band position in normalized coords (-1.5 .. 2.5 range to fully sweep)
      const bandCenter = -1.5 + t * 4;
      const bandWidth = 0.6;

      for (let i = 0; i < dots.length; i++) {
        const dot = dots[i];
        const nx = (dot.x - cx) / scale;
        const ny = (dot.y - cy) / scale;
        // Distance along the diagonal (top-left to bottom-right)
        const diag = (nx + ny) * 0.707;
        const dist = Math.abs(diag - bandCenter);

        let alpha = 0.85;
        if (dist < bandWidth) {
          // Glint: brighten dots near the band
          const intensity = 1 - dist / bandWidth;
          alpha = 0.85 + intensity * 0.15;
          const brightness = Math.round(255 + intensity * 0);
          const accent = Math.round(intensity * 80);
          ctx!.fillStyle = `rgba(${brightness}, ${brightness + accent}, 255, ${alpha})`;
        } else {
          ctx!.fillStyle = 'rgba(255, 255, 255, 0.85)';
        }

        ctx!.beginPath();
        ctx!.arc(dot.x, dot.y, r, 0, Math.PI * 2);
        ctx!.fill();
      }

      animId = requestAnimationFrame(draw);
    }

    resize();
    animId = requestAnimationFrame(draw);

    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 right-0 w-full h-screen -z-1 opacity-60 pointer-events-none hidden sm:block"
    />
  );
}
