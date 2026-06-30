"use client";

import { useEffect, useRef } from "react";

const SPACING = 47.25; // center-to-center (px)
const ICON_SIZE = 16.875; // background arrow height (px)
const ARROW_COLOR = "#ffffff"; // arrows tinted white (SVG fills black by default)
const ARROW_RATIO = 184.65 / 196.77; // width / height from the SVG viewBox
const DEFAULT_OPACITY = 0.175; // resting alpha of the background grid

// Centre emblem: a white-bordered circle with a big white arrow (6× grid arrow).
const BIG_ICON_SCALE = 4.8; // 20% smaller (was 6× the grid arrow)
const BIG_ICON_H = ICON_SIZE * BIG_ICON_SCALE;
const BIG_ICON_W = BIG_ICON_H * ARROW_RATIO;
const CIRCLE_D = ICON_SIZE * 12; // ring diameter — kept fixed as the arrow shrank

// The ring is split into 4 quarter arcs with small gaps at the cardinal points
// (a cross); a quarter fades to orange when the arrow tip points into it.
const BORDER = 4; // ring thickness (doubled from 2)
const GAP_DEG = 8; // gap between sections, centred on top/right/bottom/left
const ACTIVE_COLOR = "#FF7234"; // a section turns this when pointed at
const RING_C = CIRCLE_D / 2;
const RING_R = CIRCLE_D / 2 - BORDER / 2;
const polar = (deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [RING_C + RING_R * Math.cos(a), RING_C + RING_R * Math.sin(a)];
};
const arc = (a0: number, a1: number) => {
  const [x0, y0] = polar(a0);
  const [x1, y1] = polar(a1);
  return `M ${x0} ${y0} A ${RING_R} ${RING_R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};
// SVG angles: 0 = right, 90 = bottom, 180 = left, 270 = top (y points down).
// Index i matches quadrant i (so the arc the arrow points at lights up).
const ARCS = [
  arc(GAP_DEG / 2, 90 - GAP_DEG / 2), // bottom-right
  arc(90 + GAP_DEG / 2, 180 - GAP_DEG / 2), // bottom-left
  arc(180 + GAP_DEG / 2, 270 - GAP_DEG / 2), // top-left
  arc(270 + GAP_DEG / 2, 360 - GAP_DEG / 2), // top-right
];

export default function CompassPatternTwo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const arcRefs = useRef<(SVGPathElement | null)[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cols = 0;
    let rows = 0;
    let offsetX = 0;
    let offsetY = 0;

    let sprite: HTMLCanvasElement | null = null;
    const spriteH = ICON_SIZE;
    const spriteW = ICON_SIZE * ARROW_RATIO;

    // Rasterise the arrow and recolour it white (it fills black by default).
    const tint = (img: HTMLImageElement, color: string) => {
      const ss = 4; // supersample so the scaled-down edges stay crisp
      const c = document.createElement("canvas");
      c.width = Math.ceil(spriteW * ss);
      c.height = Math.ceil(spriteH * ss);
      const sctx = c.getContext("2d");
      if (!sctx) return null;
      sctx.drawImage(img, 0, 0, c.width, c.height);
      sctx.globalCompositeOperation = "source-in";
      sctx.fillStyle = color;
      sctx.fillRect(0, 0, c.width, c.height);
      return c;
    };

    // Static grid of faint white arrows — no cursor / click interaction.
    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0D2828";
      ctx.fillRect(0, 0, w, h);
      if (!sprite) return;
      ctx.globalAlpha = DEFAULT_OPACITY;
      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const cx = offsetX + col * SPACING;
          const cy = offsetY + row * SPACING;
          ctx.drawImage(
            sprite,
            cx - spriteW / 2,
            cy - spriteH / 2,
            spriteW,
            spriteH
          );
        }
      }
      ctx.globalAlpha = 1;
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
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
      draw();
    };

    const arrow = new Image();
    arrow.onload = () => {
      sprite = tint(arrow, ARROW_COLOR);
      draw();
    };
    arrow.src = "/arrow-icon.svg";

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Point the big arrow's tip at the cursor, easing around its own centre like a
  // clock hand.
  useEffect(() => {
    const icon = iconRef.current;
    if (!icon) return;

    const target = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 - 100, // start pointing up
    };
    let current = 0; // eased rotation (radians)
    let frame = 0;

    const onMove = (e: MouseEvent) => {
      target.x = e.clientX;
      target.y = e.clientY;
    };

    const loop = () => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      // The SVG arrow points up; +90° turns that to point along the cursor heading.
      const desired = Math.atan2(target.y - cy, target.x - cx) + Math.PI / 2;
      // Ease along the shortest path so it never spins the long way round.
      const TWO_PI = Math.PI * 2;
      let diff = desired - current;
      diff = ((diff + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
      current += diff * 0.15;
      icon.style.transform = `rotate(${current}rad)`;

      // Which quadrant the (eased) arrow tip points into → that arc goes orange.
      // The arrow points up at current = 0, i.e. SVG angle 270°.
      const tip = (((270 + (current * 180) / Math.PI) % 360) + 360) % 360;
      const quad = Math.floor(tip / 90) % 4;
      for (let i = 0; i < 4; i++) {
        const path = arcRefs.current[i];
        if (path) path.style.stroke = i === quad ? ACTIVE_COLOR : ARROW_COLOR;
      }

      frame = requestAnimationFrame(loop);
    };

    loop();
    window.addEventListener("mousemove", onMove);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <section className="relative h-screen w-screen overflow-hidden bg-[#0D2828]">
      <canvas ref={canvasRef} className="block" />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className="relative flex items-center justify-center"
          style={{ width: CIRCLE_D, height: CIRCLE_D }}
        >
          {/* Ring as 4 quarter arcs separated by gaps (a cross). Each fades to
              orange when the arrow tip points into its quadrant. */}
          <svg
            width={CIRCLE_D}
            height={CIRCLE_D}
            viewBox={`0 0 ${CIRCLE_D} ${CIRCLE_D}`}
            className="absolute inset-0"
          >
            {ARCS.map((d, i) => (
              <path
                key={i}
                ref={(el) => {
                  arcRefs.current[i] = el;
                }}
                d={d}
                fill="none"
                stroke="#ffffff"
                strokeWidth={BORDER}
                strokeLinecap="round"
                style={{ transition: "stroke 0.35s ease" }}
              />
            ))}
          </svg>
          {/* Big white arrow — CSS mask renders the black SVG as solid white.
              Rotated each frame so its tip tracks the cursor. */}
          <div
            ref={iconRef}
            aria-hidden
            style={{
              width: BIG_ICON_W,
              height: BIG_ICON_H,
              backgroundColor: "#e85a1c",
              WebkitMaskImage: "url(/arrow-icon.svg)",
              maskImage: "url(/arrow-icon.svg)",
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
            }}
          />
        </div>
      </div>
    </section>
  );
}
