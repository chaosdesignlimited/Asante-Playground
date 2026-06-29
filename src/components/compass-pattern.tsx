"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { SplitText } from "gsap/SplitText";

if (typeof window !== "undefined") {
  gsap.registerPlugin(SplitText);
}

const SPACING = 47.25; // center-to-center (px) = ICON_SIZE + gap, gap ≈ 1.8 × ICON_SIZE
const ICON_SIZE = 16.875; // drawn arrow height (px)
const ARROW_COLOR = "#ffffff"; // resting arrow tint (SVG fills black by default)
const HIGHLIGHT_COLOR = "#FF7234"; // focal-point tint, fades in toward the cursor
const ARROW_RATIO = 184.65 / 196.77; // width / height from the SVG viewBox
const DEFAULT_OPACITY = 0.175; // resting alpha (was 0.55 — now 50% less)
const ACTIVE_OPACITY = 1; // alpha for the orange focal arrows at the cursor
const HIGHLIGHT_RADIUS = 675; // px; opacity fades from full at the cursor to resting at this distance
const OPACITY_EASE = 0.12; // how fast each arrow fades toward its target opacity (0–1)

// Intro animation — an orange wave sweeps up through the arrows, then the
// headline rises in from behind a mask once the wave clears the top.
const WAVE_DURATION = 1.8; // seconds for the band to travel bottom → top
const WAVE_BAND_FRAC = 0.4; // band thickness as a fraction of viewport height
const REVEAL_DURATION = 0.55; // seconds for each headline line to rise
const REVEAL_STAGGER = 0.07; // delay between lines

// Click-ripple easter egg — an orange ring expands from the click like a drop in
// water; the cursor focal glow eases back once the ripple clears the screen.
const RIPPLE_SPEED = 1200; // px/s the ring expands outward
const RIPPLE_BAND = 160; // px thickness of the ring at the start
const RIPPLE_BAND_GROWTH = 1.5; // band widens by up to this × its base as it reaches the edge
const FOCAL_RETURN_EASE = 0.025; // how gently the focal glow returns after a ripple

export default function CompassPattern() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  // Center of the intro wave band, in screen px. Infinity parks it off-screen so
  // it contributes nothing until the timeline animates it. Shared between the
  // canvas loop (reads it) and the GSAP timeline (animates it).
  const waveRef = useRef({ y: Number.POSITIVE_INFINITY });

  // Click-ripple easter egg toggle. The canvas listener reads the ref (it's set
  // up once); the state just drives the toggle button's label.
  const [rippleOn, setRippleOn] = useState(true);
  const rippleOnRef = useRef(true);
  useEffect(() => {
    rippleOnRef.current = rippleOn;
  }, [rippleOn]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const target = { x: -9999, y: -9999 };
    let pointerInside = false;

    // Click-ripple easter egg state (see RIPPLE_* constants).
    const ripples: { x: number; y: number; start: number }[] = [];
    let focal = 1; // cursor-glow strength; a click drops it to 0, then it eases back

    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let offsetX = 0;
    let offsetY = 0;
    let frame = 0;

    // Current (eased) focal intensity per arrow (0 = resting white, 1 = full
    // orange at the cursor), indexed col * rows + row.
    let glow = new Float32Array(0);

    // The arrow SVG, pre-rasterised once it loads — a white resting copy and an
    // orange focal copy. Drawing these sprites per cell is far cheaper than
    // re-rasterising the SVG, and layering them lets the colour blend per arrow.
    let baseSprite: HTMLCanvasElement | null = null;
    let hiSprite: HTMLCanvasElement | null = null;
    const spriteH = ICON_SIZE;
    const spriteW = ICON_SIZE * ARROW_RATIO;

    // Rasterise the arrow and recolour it: keep the silhouette (its alpha) but
    // swap the fill to `color`.
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

    const arrow = new Image();
    arrow.onload = () => {
      baseSprite = tint(arrow, ARROW_COLOR);
      hiSprite = tint(arrow, HIGHLIGHT_COLOR);
    };
    arrow.src = "/arrow-icon.svg";

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

      // Preserve nothing on resize — size the glow buffer to the new grid.
      // Seeded at 0 so the grid starts as the resting white pattern.
      glow = new Float32Array(cols * rows);
    };

    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0D2828";
      ctx.fillRect(0, 0, w, h);

      // Sprites not ready yet — just show the background this frame.
      if (!baseSprite || !hiSprite) return;

      const now = performance.now();
      const maxR = Math.sqrt(w * w + h * h) + RIPPLE_BAND; // ring fully off-screen

      // Advance the click ripples: drop any that have cleared the screen, and
      // precompute each survivor's current radius + fading amplitude.
      const live: { x: number; y: number; r: number; amp: number; band: number }[] =
        [];
      for (let k = ripples.length - 1; k >= 0; k--) {
        const r = ((now - ripples[k].start) / 1000) * RIPPLE_SPEED;
        if (r > maxR) {
          ripples.splice(k, 1);
          continue;
        }
        // The ring thickens as it travels outward, like a spreading water ripple.
        const band = RIPPLE_BAND * (1 + RIPPLE_BAND_GROWTH * (r / maxR));
        live.push({ x: ripples[k].x, y: ripples[k].y, r, amp: 1 - r / maxR, band });
      }

      // Once every ripple has gone, ease the cursor focal glow gently back in.
      if (ripples.length === 0 && focal < 1) {
        focal += (1 - focal) * FOCAL_RETURN_EASE;
      }

      const band = h * WAVE_BAND_FRAC;

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const i = col * rows + row;
          const cx = offsetX + col * SPACING;
          const cy = offsetY + row * SPACING;
          const x = cx - spriteW / 2;
          const y = cy - spriteH / 2;

          // Cursor focal falloff, scaled by `focal` so a click can suppress it.
          const dx = target.x - cx;
          const dy = target.y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          let cursorT = pointerInside ? 1 - dist / HIGHLIGHT_RADIUS : 0;
          cursorT = cursorT < 0 ? 0 : cursorT * cursorT * (3 - 2 * cursorT);
          cursorT *= focal;

          // Intro wave: a broad horizontal band sweeping up the screen.
          let waveT = 1 - Math.abs(cy - waveRef.current.y) / band;
          waveT = waveT < 0 ? 0 : waveT * waveT * (3 - 2 * waveT);

          // Cursor + wave share the eased glow buffer.
          const targetGlow = cursorT > waveT ? cursorT : waveT;
          glow[i] += (targetGlow - glow[i]) * OPACITY_EASE;

          // Click ripples: a crisp orange ring around each expanding radius.
          let rippleT = 0;
          for (let k = 0; k < live.length; k++) {
            const lr = live[k];
            const rdx = cx - lr.x;
            const rdy = cy - lr.y;
            const rd = Math.sqrt(rdx * rdx + rdy * rdy);
            let rt = 1 - Math.abs(rd - lr.r) / lr.band;
            if (rt > 0) {
              rt = rt * rt * (3 - 2 * rt) * lr.amp;
              if (rt > rippleT) rippleT = rt;
            }
          }

          // Strongest source wins (eased glow vs. instantaneous ripple ring).
          const intensity = glow[i] > rippleT ? glow[i] : rippleT;

          // Resting white grid underneath (arrows already point up — no rotation).
          ctx.globalAlpha = DEFAULT_OPACITY;
          ctx.drawImage(baseSprite, x, y, spriteW, spriteH);

          // Orange arrow on top — focal glow and/or ripple ring.
          if (intensity > 0.001) {
            ctx.globalAlpha = intensity * ACTIVE_OPACITY;
            ctx.drawImage(hiSprite, x, y, spriteW, spriteH);
          }
        }
      }

      ctx.globalAlpha = 1;
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

    const onClick = (e: MouseEvent) => {
      if (!rippleOnRef.current) return;
      ripples.push({ x: e.clientX, y: e.clientY, start: performance.now() });
      focal = 0; // the focal blob "drops" and becomes the expanding ripple
    };

    resize();
    loop();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  // Intro timeline: sweep the orange wave up, then reveal the headline.
  useEffect(() => {
    const headline = headlineRef.current;
    if (!headline) return;

    const wave = waveRef.current; // stable container shared with the canvas loop
    const tl = gsap.timeline({ paused: true });
    let split: SplitText | null = null;
    let cancelled = false;

    const build = () => {
      if (cancelled) return;

      // Split into lines, each wrapped in an overflow-clip mask so the line can
      // rise up "from behind a mask". `.split-line` adds bottom padding so the
      // mask doesn't crop descenders.
      split = SplitText.create(headline, {
        type: "lines",
        mask: "lines",
        linesClass: "split-line",
      });

      const band = window.innerHeight * WAVE_BAND_FRAC;
      wave.y = window.innerHeight + band; // park the band below the screen

      tl.to(wave, {
        y: -band, // sweep the band's centre past the top of the screen
        duration: WAVE_DURATION,
        ease: "power1.inOut",
      })
        // Wave has cleared — show the headline container, then rise each line.
        .set(headline, { autoAlpha: 1 })
        .from(split.lines, {
          yPercent: 110,
          duration: REVEAL_DURATION,
          stagger: REVEAL_STAGGER,
          ease: "power3.out",
        });

      tl.play();
    };

    // Wait for the Adobe font so SplitText measures the line breaks correctly.
    document.fonts.ready.then(build);

    return () => {
      cancelled = true;
      tl.kill();
      split?.revert();
      wave.y = Number.POSITIVE_INFINITY;
    };
  }, []);

  return (
    <section className="relative h-screen w-screen overflow-hidden bg-[#0D2828]">
      <canvas ref={canvasRef} className="block" />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-16">
        <h1
          ref={headlineRef}
          className="px-6 text-center font-ivy font-light leading-[1.1] tracking-tight text-[#F8F6F3] opacity-0"
          style={{ fontSize: "clamp(2.5rem, 9vw, 7rem)" }}
        >
          Beyond the benchmark.
        </h1>
      </div>
      <button
        type="button"
        onClick={() => setRippleOn((v) => !v)}
        className="absolute bottom-5 right-5 rounded-full border border-white/20 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-white/60 backdrop-blur-sm transition-colors hover:border-white/40 hover:text-white/90"
      >
        Ripple {rippleOn ? "on" : "off"}
      </button>
    </section>
  );
}
