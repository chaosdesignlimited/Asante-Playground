"use client";

import { useEffect, useRef } from "react";

const SPACING = 32; // distance between line centers (px)
const LINE_LENGTH = 16; // line length (px)
const LINE_WIDTH = 2; // line thickness (px)
const ANGLE_EASE = 0.06; // how fast each line rotates toward its target (0–1)
const MOUSE_EASE = 0.08; // how fast the tracked cursor catches up to the real one
const REST_ANGLE = 0; // default orientation when the cursor leaves (0 = horizontal)

export default function LineGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Raw cursor target vs. the smoothed value we actually draw toward.
    const target = { x: -9999, y: -9999 };
    const mouse = { x: -9999, y: -9999 };
    let pointerInside = false;

    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let offsetX = 0;
    let offsetY = 0;
    let frame = 0;

    // Current (eased) angle for every line, indexed col * rows + row.
    let angles = new Float32Array(0);

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const { innerWidth: w, innerHeight: h } = window;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.floor(w / SPACING);
      rows = Math.floor(h / SPACING);
      offsetX = (w - (cols - 1) * SPACING) / 2;
      offsetY = (h - (rows - 1) * SPACING) / 2;

      // Preserve nothing on resize — just size the angle buffer to the new grid.
      angles = new Float32Array(cols * rows);
    };

    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;

      // Ease the tracked cursor toward the real pointer.
      mouse.x += (target.x - mouse.x) * MOUSE_EASE;
      mouse.y += (target.y - mouse.y) * MOUSE_EASE;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0D2728";
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.lineWidth = LINE_WIDTH;
      ctx.lineCap = "round";

      const half = LINE_LENGTH / 2;
      const TWO_PI = Math.PI * 2;

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const i = col * rows + row;
          const cx = offsetX + col * SPACING;
          const cy = offsetY + row * SPACING;

          const targetAngle = pointerInside
            ? Math.atan2(mouse.y - cy, mouse.x - cx)
            : REST_ANGLE;

          // Rotate along the shortest path so lines never spin the long way.
          let diff = targetAngle - angles[i];
          diff = ((diff + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
          angles[i] += diff * ANGLE_EASE;

          const dx = Math.cos(angles[i]) * half;
          const dy = Math.sin(angles[i]) * half;

          ctx.beginPath();
          ctx.moveTo(cx - dx, cy - dy);
          ctx.lineTo(cx + dx, cy + dy);
          ctx.stroke();
        }
      }
    };

    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };

    const onMove = (e: MouseEvent) => {
      target.x = e.clientX;
      target.y = e.clientY;
      pointerInside = true;
    };

    const onLeave = () => {
      pointerInside = false;
    };

    resize();
    loop();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <section className="relative h-screen w-screen overflow-hidden bg-[#0D2728]">
      <canvas ref={canvasRef} className="block" />
    </section>
  );
}
