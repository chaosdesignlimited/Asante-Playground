"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { Group, Mesh, BufferGeometry } from "three";
import { Shape, Path, ExtrudeGeometry, NeutralToneMapping } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
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

type ShapeParams = {
  radius: number;
  hole: number;
  depth: number;
  bevel: number;
  spin: number;
};

type MorphParams = {
  delay: number;
  duration: number;
  barWidth: number;
  barHeight: number;
  tilt: number;
  tiltDelay: number;
  tiltDuration: number;
};

// ── Morph geometry ─────────────────────────────────────────────────────────
// The shape is rebuilt from scratch for a morph progress t (0 = solid rectangle
// bar, 1 = hollow circular ring). Both the outer outline AND the inner hole are
// interpolated, so the bar smoothly rounds off into a ring as t goes 0 → 1.

const OUTER_SEGMENTS = 160; // points around the outer outline
const HOLE_SEGMENTS = 120; // points around the inner hole
const BEVEL_SEGMENTS = 10; // rounding resolution of the bevelled edges — higher
// = smoother rounded corners, so sharp reflections glide across them flatly
const HOLE_MIN = 0.01; // below this inner radius we skip the hole (stays solid)

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// Outer outline sampled by angle: a point on a `barWidth × barHeight` rectangle
// at t=0, lerped toward a point on a circle of `radius` at t=1. Sampling both by
// the same angle keeps a clean correspondence so the rectangle inflates into the
// circle without the points sliding around.
function outerContour(
  radius: number,
  barWidth: number,
  barHeight: number,
  t: number
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < OUTER_SEGMENTS; i++) {
    const ang = (i / OUTER_SEGMENTS) * Math.PI * 2; // CCW
    const cx = Math.cos(ang);
    const cy = Math.sin(ang);
    // Distance from centre to the rectangle edge along this ray.
    const rRect = Math.min(
      barWidth / 2 / Math.max(Math.abs(cx), 1e-6),
      barHeight / 2 / Math.max(Math.abs(cy), 1e-6)
    );
    pts.push([lerp(cx * rRect, radius * cx, t), lerp(cy * rRect, radius * cy, t)]);
  }
  return pts;
}

// Inner hole — a circle of `innerRadius`, wound CW (opposite the outer) so the
// extruder reads it as a hole rather than a second filled disc.
function holeContour(innerRadius: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < HOLE_SEGMENTS; i++) {
    const ang = -(i / HOLE_SEGMENTS) * Math.PI * 2; // CW
    pts.push([Math.cos(ang) * innerRadius, Math.sin(ang) * innerRadius]);
  }
  return pts;
}

function traceShape(shape: Shape | Path, pts: [number, number][]) {
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
}

function buildGeometry(
  t: number,
  shape: ShapeParams,
  morph: MorphParams
): BufferGeometry {
  const outline = new Shape();
  traceShape(outline, outerContour(shape.radius, morph.barWidth, morph.barHeight, t));

  // Hole grows from nothing → the ring's full inner radius. While it's tiny the
  // shape stays solid, so the bar reads as a genuine solid rectangle at t=0.
  const innerRadius = shape.radius * shape.hole * t;
  if (innerRadius > HOLE_MIN) {
    const hole = new Path();
    traceShape(hole, holeContour(innerRadius));
    outline.holes.push(hole);
  }

  let geo: BufferGeometry = new ExtrudeGeometry(outline, {
    depth: shape.depth,
    bevelEnabled: shape.bevel > 0,
    bevelThickness: shape.bevel,
    bevelSize: shape.bevel,
    bevelSegments: BEVEL_SEGMENTS,
    steps: 1,
    curveSegments: 1, // outline is already an explicit polygon
  });
  // Weld coincident vertices + recompute normals so the side wall shades as one
  // smooth surface instead of visible facets.
  geo.deleteAttribute("uv");
  geo.deleteAttribute("normal");
  geo = mergeVertices(geo);
  geo.computeVertexNormals();
  geo.center();
  return geo;
}

function RingShape({
  glass,
  shape,
  morph,
  runId,
}: {
  glass: GlassProps;
  shape: ShapeParams;
  morph: MorphParams;
  runId: number;
}) {
  const spinRef = useRef<Group>(null);
  const meshRef = useRef<Mesh>(null);
  const geoRef = useRef<BufferGeometry | null>(null);
  // startedAt: clock time the morph timer began (-1 = not started yet).
  // builtP / sig: cache so we only rebuild geometry when it actually changes.
  const anim = useRef({ startedAt: -1, builtP: -1, sig: "" });

  // (Re)start the morph whenever runId changes (first scroll-into-view, replay).
  useEffect(() => {
    if (runId > 0) {
      anim.current.startedAt = -1;
      anim.current.builtP = -1;
    }
  }, [runId]);

  // Free the GPU buffers of the last geometry we built when this unmounts.
  useEffect(() => () => geoRef.current?.dispose(), []);

  useFrame((state, delta) => {
    if (spinRef.current) spinRef.current.rotation.y += delta * shape.spin;
    const mesh = meshRef.current;
    if (!mesh) return;
    const a = anim.current;

    // Begin the timer on the frame after the section comes into view.
    if (runId > 0 && a.startedAt < 0) a.startedAt = state.clock.elapsedTime;

    // Timeline, in seconds from when the section came into view:
    //   0 .. delay                          → hold the solid bar
    //   delay .. delay+duration             → morph bar → ring (edge-on, subtle)
    //   +tiltDelay then over tiltDuration    → angle up to reveal the circle
    let p = 0;
    let tilt = 0;
    if (a.startedAt >= 0) {
      const elapsed = state.clock.elapsedTime - a.startedAt;
      p =
        elapsed <= morph.delay
          ? 0
          : Math.min(1, (elapsed - morph.delay) / morph.duration);
      const tiltStart = morph.delay + morph.duration + morph.tiltDelay;
      tilt =
        elapsed <= tiltStart
          ? 0
          : Math.min(1, (elapsed - tiltStart) / morph.tiltDuration);
    }
    const eased = easeInOutCubic(p);

    // Edge-on (π/2) through the morph; then, a beat later, angle up toward the
    // camera so the ring is unmistakably a circle. Drag composes on top of this.
    const tiltRad = (morph.tilt * Math.PI) / 180;
    mesh.rotation.x = Math.PI / 2 - easeInOutCubic(tilt) * tiltRad;

    // Only rebuild the geometry when the morph progress moves or the shape
    // params change (so Leva edits still take effect when not animating).
    const sig = `${shape.radius}|${shape.hole}|${shape.depth}|${shape.bevel}|${morph.barWidth}|${morph.barHeight}`;
    if (Math.abs(eased - a.builtP) > 0.0008 || sig !== a.sig) {
      const geo = buildGeometry(eased, shape, morph);
      geoRef.current?.dispose();
      geoRef.current = geo;
      mesh.geometry = geo;
      a.builtP = eased;
      a.sig = sig;
    }
  });

  return (
    <group ref={spinRef}>
      {/* No geometry child — it's assigned imperatively each frame during the
          morph so React doesn't fight the useFrame updates. Orientation is
          driven in useFrame too: edge-on (so the morph reads as a subtle solid
          bar) until the tilt phase angles it up to reveal the circle. */}
      <mesh ref={meshRef}>
        {/* Frosted, hollow-looking glass. `backside` renders the far inner
            walls through the near surface so you see into and through the
            shape; anisotropicBlur + roughness frost it. Colour fringing /
            distortion pinned off so it stays neutral. */}
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

export default function SectionFive() {
  // Own Leva store so this scene's panel doesn't collide with other sections'.
  const store = useCreateStore();

  // runId drives the morph: 0 = idle (solid bar), bumped to start / replay it.
  const [runId, setRunId] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  // Kick off the morph the first time the section scrolls into view.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setRunId((r) => (r === 0 ? 1 : r));
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The target shape — a deep, hollow ring (full circle with a hole through it).
  const shape = useControls(
    "Shape",
    {
      radius: { value: 1, min: 0.3, max: 2, step: 0.05 },
      hole: { value: 0.55, min: 0, max: 0.9, step: 0.01 },
      depth: { value: 0.45, min: 0.01, max: 5, step: 0.01 },
      bevel: { value: 0.02, min: 0, max: 0.3, step: 0.01 },
      spin: { value: 0, min: 0, max: 2, step: 0.05 },
    },
    { store }
  );

  const morph = useControls(
    "Morph",
    {
      delay: { value: 3, min: 0, max: 10, step: 0.1 },
      duration: { value: 1.6, min: 0.2, max: 5, step: 0.1 },
      // Match the ring's diameter (2 × radius) so the edge-on outline width
      // barely changes as it morphs — keeps the effect subtle from the front.
      barWidth: { value: 2.0, min: 0.5, max: 4, step: 0.05 },
      barHeight: { value: 0.6, min: 0.05, max: 2, step: 0.05 },
      // Reveal: how far it angles to show the circle (deg; sign flips the
      // direction, ±90 = fully face-on), the pause after the morph, and how
      // long the tilt takes.
      tilt: { value: -18, min: -90, max: 90, step: 1 },
      tiltDelay: { value: 1, min: 0, max: 5, step: 0.1 },
      tiltDuration: { value: 1.2, min: 0.2, max: 4, step: 0.1 },
      Replay: button(() => setRunId((r) => r + 1)),
    },
    { store }
  );

  const glass = useControls(
    "Glass",
    {
      color: "#ffffff",
      // Frosted glass: transmission keeps it see-through, but a high roughness
      // scatters/blurs the transmitted light into a soft frost.
      transmission: { value: 1, min: 0, max: 1, step: 0.01 },
      // Low = thin-walled glass you can see through to the far walls (empty
      // jar); high = dense solid lump of glass.
      thickness: { value: 0.3, min: 0, max: 5, step: 0.05 },
      ior: { value: 1.5, min: 1, max: 2.33, step: 0.01 },
      // 0 = crystal clear / sharp refraction; raise it to frost the glass.
      roughness: { value: 0, min: 0, max: 1, step: 0.01 },
      // Hollow look: backside renders the far inner walls through the near
      // surface, so you see into and out the other side of the glass.
      hollow: folder(
        {
          backside: true,
          backsideThickness: { value: 1.0, min: 0, max: 5, step: 0.05 },
          // 0 = no frost blur; raise alongside roughness to frost it.
          anisotropicBlur: { value: 0, min: 0, max: 2, step: 0.01 },
          samples: { value: 10, min: 1, max: 32, step: 1 },
        },
        { collapsed: false }
      ),
      // Volumetric tint (Beer–Lambert). Left white = no colour; drop a colour
      // here for tinted glass where thicker parts read deeper.
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
          // No glossy coat — frosted glass has a matte, scattering surface.
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
      className="relative h-screen w-screen bg-[#F8F6F3] text-[#0D2728]"
    >
      <div className="absolute right-3 top-3 z-10 w-72">
        <LevaPanel store={store} fill flat titleBar={{ title: "Shape" }} />
      </div>
      <Canvas
        // Eye-level, looking straight on — the ring sits edge-on, reading as a
        // level horizontal bar until you drag it off-axis.
        camera={{ position: [0, 0, 5], fov: 45 }}
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
          {/* Drag rotates the model (camera/lighting stay put); 1.5s after you
              let go it eases back to the default orientation. */}
          <DragToRotate resetDelay={1500}>
            <RingShape glass={glass} shape={shape} morph={morph} runId={runId} />
          </DragToRotate>
          <Environment
            preset={preset as ComponentProps<typeof Environment>["preset"]}
            environmentIntensity={environmentIntensity}
          />
        </Suspense>
      </Canvas>

      {/* Title sits just above where the bar rests before it morphs. The model
          is centred, so the bar is at the vertical middle of the section;
          anchoring the h1's bottom a little above 50% places it just over it. */}
      <h1 className="pointer-events-none absolute left-1/2 top-[42%] z-10 -translate-x-1/2 -translate-y-full text-center text-4xl font-semibold tracking-tight text-[#0D2728] md:text-6xl">
        Beyond the benchmark<span className="text-[#FF7234]">.</span>
      </h1>

      <p className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-sm opacity-50">
        Drag to rotate · tune the shape in the panel →
      </p>
    </section>
  );
}
