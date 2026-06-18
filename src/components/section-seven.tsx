"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { Group, Mesh, BufferGeometry } from "three";
import { Shape, ExtrudeGeometry, Matrix4, NeutralToneMapping } from "three";
import {
  mergeVertices,
  mergeGeometries,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, MeshTransmissionMaterial } from "@react-three/drei";
import {
  LevaPanel,
  useControls,
  useCreateStore,
  folder,
  button,
} from "leva";
import DragToRotate from "./drag-to-rotate";

type GlassProps = {
  color: string;
  transmission: number;
  thickness: number;
  ior: number;
  roughness: number;
  attenuationColor: string;
  attenuationDistance: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  backside: boolean;
  backsideThickness: number;
  anisotropicBlur: number;
  samples: number;
};

type BarParams = {
  width: number;
  height: number;
  depth: number;
  bevel: number;
};

type StackParams = {
  delay: number;
  duration: number;
  thickness: number;
  gap: number;
  thinning: number;
  explodeDelay: number;
  explodeDuration: number;
  radius: number;
  swirl: number;
  scrollScale: number;
  tiltDeg: number;
};

// ── Bar geometry ────────────────────────────────────────────────────────────
// Static solid bar that splits width-wise into 4 thin layers, then the layers
// explode and the cluster orbits around the centre.

const OUTER_SEGMENTS = 160;
const BEVEL_SEGMENTS = 10;

const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// Rectangle outline sampled by angle (matches section six's bar at morph t=0).
function rectContour(width: number, height: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < OUTER_SEGMENTS; i++) {
    const ang = (i / OUTER_SEGMENTS) * Math.PI * 2;
    const cx = Math.cos(ang);
    const cy = Math.sin(ang);
    const r = Math.min(
      width / 2 / Math.max(Math.abs(cx), 1e-6),
      height / 2 / Math.max(Math.abs(cy), 1e-6)
    );
    pts.push([cx * r, cy * r]);
  }
  return pts;
}

function extrudeRect(
  width: number,
  height: number,
  depth: number,
  bevel: number
): BufferGeometry {
  const outline = new Shape();
  const pts = rectContour(width, height);
  outline.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) outline.lineTo(pts[i][0], pts[i][1]);
  outline.closePath();

  let geo: BufferGeometry = new ExtrudeGeometry(outline, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: BEVEL_SEGMENTS,
    steps: 1,
    curveSegments: 1,
  });
  geo.deleteAttribute("uv");
  geo.deleteAttribute("normal");
  geo = mergeVertices(geo);
  geo.computeVertexNormals();
  return geo;
}

function buildBar(bar: BarParams): BufferGeometry {
  const geo = extrudeRect(bar.width, bar.height, bar.depth, bar.bevel);
  geo.center();
  return geo;
}

// Split + explode: 4 thin full-width layers that thin from a solid quarter and
// spread (split), then stand up vertical and fan out to equally-spaced points on
// a perfect circle (explode). The cluster's swirl is around the vertical axis,
// so they stay upright while the circle rotates.
function buildLayers(
  bar: BarParams,
  split: number,
  explode: number,
  thickness: number,
  gap: number,
  radius: number,
  thinning: number
): BufferGeometry {
  const { width: W, height: H, depth: D } = bar;
  const quarter = D / 4;
  // Thin from a solid quarter → `thickness` (split), then thin further as they
  // break apart (explode), by up to `thinning`.
  const splitThick = quarter * (1 - split) + thickness * split;
  const thick = splitThick * (1 - thinning * explode);
  const spacing = quarter * (1 - split) + (thickness + gap) * split;
  const halfH = H / 2;
  const parts: BufferGeometry[] = [];
  // 8 segments: the 4 split layers each break into 2 (along depth) as they
  // explode, doubling the count right as they fan out and start rotating. Each
  // half then fills its depth back to full (halfH → H), so the 8 keep the same
  // full width AND full height as the original segments.
  for (let i = 0; i < 8; i++) {
    const layer = Math.floor(i / 2);
    const half = i % 2;
    // Depth grows from a half (forming the layer) back to full as it separates.
    const segH = halfH * (1 + explode);
    // Same bevel as the starting bar so the glass edge finish matches exactly.
    const g = extrudeRect(W, segH, thick, bar.bevel);
    g.translate(0, 0, -thick / 2);

    const theta = i * (Math.PI / 4); // 8 evenly-spaced points (45° apart)
    // Stand it up, then spin so its thin side edge faces the centre (radial).
    if (explode > 0) {
      g.applyMatrix4(new Matrix4().makeRotationY((Math.PI / 2) * explode));
      g.applyMatrix4(
        new Matrix4().makeRotationZ((theta - Math.PI / 2) * explode)
      );
    }

    // Two depth-halves of the layer at split → a circle point at explode.
    const yOff = (half * 2 - 1) * (halfH / 2); // ±H/4 — the layer's two halves
    const zSpread = (layer - 1.5) * spacing;
    const cx = Math.cos(theta) * radius;
    const cy = Math.sin(theta) * radius;
    g.translate(
      cx * explode,
      yOff * (1 - explode) + cy * explode,
      zSpread * (1 - explode)
    );
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function Bar({
  glass,
  bar,
  stack,
  runId,
  sectionRef,
}: {
  glass: GlassProps;
  bar: BarParams;
  stack: StackParams;
  runId: number;
  sectionRef: { readonly current: HTMLElement | null };
}) {
  const swirlRef = useRef<Group>(null);
  const meshRef = useRef<Mesh>(null);
  const geoRef = useRef<BufferGeometry | null>(null);
  const scrollRef = useRef(0); // smoothed scroll-through progress [0..1]
  const anim = useRef({ startedAt: -1, builtSplit: -1, builtExplode: -1, sig: "" });

  useEffect(() => {
    if (runId > 0) {
      anim.current.startedAt = -1;
      anim.current.builtSplit = -1;
      anim.current.builtExplode = -1;
    }
  }, [runId]);

  useEffect(() => () => geoRef.current?.dispose(), []);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const a = anim.current;

    if (runId > 0 && a.startedAt < 0) a.startedAt = state.clock.elapsedTime;

    // Forward timeline (clock): hold bar · split into thin layers · explode.
    let splitP = 0;
    let explodeP = 0;
    if (a.startedAt >= 0) {
      const elapsed = state.clock.elapsedTime - a.startedAt;
      splitP =
        elapsed <= stack.delay
          ? 0
          : Math.min(1, (elapsed - stack.delay) / stack.duration);
      const explodeStart = stack.delay + stack.duration + stack.explodeDelay;
      explodeP =
        elapsed <= explodeStart
          ? 0
          : Math.min(1, (elapsed - explodeStart) / stack.explodeDuration);
    }

    // Scroll through the 200vh section: 0 = top, 1 = section bottom at the
    // viewport bottom (end of the sticky pin).
    let target = 0;
    const el = sectionRef.current;
    if (el) {
      const vh = window.innerHeight || 1;
      const rect = el.getBoundingClientRect();
      target = Math.min(1, Math.max(0, -rect.top / Math.max(rect.height - vh, 1)));
    }
    scrollRef.current += (target - scrollRef.current) * Math.min(1, delta * 6);
    const scroll = scrollRef.current;

    const split = easeInOutCubic(splitP);
    const explode = easeInOutCubic(explodeP);

    if (swirlRef.current) {
      swirlRef.current.rotation.y += delta * stack.swirl * explode;
      // Scroll keeps growing the cluster and tips the whole ring over toward
      // `tiltDeg` so it angles away as you go down.
      swirlRef.current.rotation.x =
        scroll * (stack.tiltDeg * (Math.PI / 180)) * explode;
      swirlRef.current.scale.setScalar(1 + scroll * stack.scrollScale);
    }

    const sig = `${bar.width}|${bar.height}|${bar.depth}|${bar.bevel}|${stack.thickness}|${stack.gap}|${stack.radius}|${stack.thinning}`;
    if (
      Math.abs(split - a.builtSplit) > 0.0008 ||
      Math.abs(explode - a.builtExplode) > 0.0008 ||
      sig !== a.sig
    ) {
      const geo =
        split > 0 || explode > 0
          ? buildLayers(
              bar,
              split,
              explode,
              stack.thickness,
              stack.gap,
              stack.radius,
              stack.thinning
            )
          : buildBar(bar);
      geoRef.current?.dispose();
      geoRef.current = geo;
      mesh.geometry = geo;
      a.builtSplit = split;
      a.builtExplode = explode;
      a.sig = sig;
    }
  });

  return (
    <group ref={swirlRef}>
      <mesh ref={meshRef} rotation-x={Math.PI / 2}>
        <MeshTransmissionMaterial
          {...glass}
          chromaticAberration={0}
          distortion={0}
          temporalDistortion={0}
          resolution={1024}
          backsideResolution={1024}
        />
      </mesh>
    </group>
  );
}

export default function SectionSeven() {
  const store = useCreateStore();
  const [runId, setRunId] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setRunId((r) => (r === 0 ? 1 : r));
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const bar = useControls(
    "Bar",
    {
      width: { value: 2.0, min: 0.5, max: 4, step: 0.05 },
      height: { value: 0.6, min: 0.05, max: 2, step: 0.05 },
      depth: { value: 0.45, min: 0.01, max: 5, step: 0.01 },
      bevel: { value: 0.02, min: 0, max: 0.3, step: 0.01 },
    },
    { store }
  );

  const stack = useControls(
    "Stack",
    {
      delay: { value: 1, min: 0, max: 5, step: 0.1 },
      duration: { value: 1.2, min: 0.2, max: 5, step: 0.1 },
      thickness: { value: 0.05, min: 0.02, max: 0.3, step: 0.01 },
      gap: { value: 0.1, min: 0, max: 0.5, step: 0.01 },
      // How much thinner each segment gets as it breaks apart (0.5 = half).
      thinning: { value: 0.5, min: 0, max: 0.9, step: 0.05 },
      explodeDelay: { value: 0.3, min: 0, max: 5, step: 0.1 },
      explodeDuration: { value: 1.2, min: 0.2, max: 5, step: 0.1 },
      radius: { value: 1.0, min: 0, max: 3, step: 0.05 }, // circle radius
      swirl: { value: 0.4, min: -2, max: 2, step: 0.05 },
      // Scroll (200vh): grow as you scroll, then reform the bar near the bottom.
      scrollScale: { value: 2, min: 0, max: 12, step: 0.5 }, // how much it grows
      tiltDeg: { value: 70, min: 0, max: 120, step: 5 }, // tip-over at full scroll
      Replay: button(() => setRunId((r) => r + 1)),
    },
    { store }
  );

  const glass = useControls(
    "Glass",
    {
      color: "#ffffff",
      transmission: { value: 1, min: 0, max: 1, step: 0.01 },
      thickness: { value: 0.3, min: 0, max: 5, step: 0.05 },
      ior: { value: 1.5, min: 1, max: 2.33, step: 0.01 },
      roughness: { value: 0, min: 0, max: 1, step: 0.01 },
      hollow: folder(
        {
          backside: true,
          backsideThickness: { value: 1.0, min: 0, max: 5, step: 0.05 },
          anisotropicBlur: { value: 0, min: 0, max: 2, step: 0.01 },
          samples: { value: 10, min: 1, max: 32, step: 1 },
        },
        { collapsed: true }
      ),
      absorption: folder(
        {
          attenuationColor: "#ffffff",
          attenuationDistance: { value: 1.5, min: 0.1, max: 10, step: 0.1 },
        },
        { collapsed: true }
      ),
      sheen: folder(
        {
          metalness: { value: 0, min: 0, max: 1, step: 0.01 },
          clearcoat: { value: 0, min: 0, max: 1, step: 0.01 },
          clearcoatRoughness: { value: 0.1, min: 0, max: 1, step: 0.01 },
        },
        { collapsed: true }
      ),
    },
    { store }
  );

  const { lightColor, lightIntensity } = useControls(
    "Lighting",
    {
      lightColor: "#ffffff",
      lightIntensity: { value: 1.5, min: 0, max: 10, step: 0.1 },
    },
    { store }
  );

  const { preset, environmentIntensity, background } = useControls(
    "Scene",
    {
      preset: {
        value: "studio",
        options: [
          "apartment",
          "city",
          "studio",
          "warehouse",
          "sunset",
          "dawn",
          "park",
          "lobby",
          "forest",
          "night",
        ],
      },
      environmentIntensity: { value: 1.2, min: 0, max: 4, step: 0.1 },
      background: "#F8F6F3",
    },
    { store }
  );

  return (
    <section
      ref={sectionRef}
      className="relative h-[300vh] w-screen bg-[#F8F6F3] text-[#0D2728]"
    >
      {/* Sticky stage: pinned to the viewport while you scroll the 200vh. */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
      <div className="absolute right-3 top-3 z-10 w-72">
        <LevaPanel
          store={store}
          fill
          flat
          collapsed
          titleBar={{ title: "Bar" }}
        />
      </div>
      <Canvas
        // Far camera + narrow lens ≈ orthographic: flattens perspective so the
        // standing rectangles read as rectangles (no foreshortening taper).
        camera={{ position: [0, 0, 17], fov: 14 }}
        gl={{ antialias: true, toneMapping: NeutralToneMapping }}
        dpr={[1, 2]}
      >
        <color attach="background" args={[background]} />

        <directionalLight
          position={[3, 5, 4]}
          intensity={lightIntensity}
          color={lightColor}
        />

        <Suspense fallback={null}>
          {/* Draggable from the start; eases back to the resting pose 1.5s after
              you let go. */}
          <DragToRotate resetDelay={1500}>
            <Bar
              glass={glass}
              bar={bar}
              stack={stack}
              runId={runId}
              sectionRef={sectionRef}
            />
          </DragToRotate>
          <Environment
            preset={preset as ComponentProps<typeof Environment>["preset"]}
            environmentIntensity={environmentIntensity}
          />
        </Suspense>
      </Canvas>

      {/* Title sits just above where the bar rests. */}
      <h1 className="pointer-events-none absolute left-1/2 top-[43%] z-10 -translate-x-1/2 -translate-y-full text-center text-4xl font-semibold tracking-tight text-[#0D2728] md:text-6xl">
        Beyond the benchmark<span className="text-[#FF7234]">.</span>
      </h1>
      </div>
    </section>
  );
}
