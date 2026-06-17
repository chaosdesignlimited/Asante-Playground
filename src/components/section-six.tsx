"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps } from "react";
import type { Group, Mesh, BufferGeometry } from "three";
import {
  Shape,
  Path,
  ExtrudeGeometry,
  Matrix4,
  Vector3,
  Quaternion,
  Euler,
  NeutralToneMapping,
} from "three";
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

type SplitParams = {
  enabled: boolean;
  separation: number;
  delay: number;
  duration: number;
  swirl: number;
  grow: number;
  float: number;
  scrollGrow: number;
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
// Fraction of the section's height it scrolls out over before the scroll-grow
// reaches full — smaller = grows faster as it leaves.
const SCROLL_SPAN = 0.6;

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

// Deterministic per-piece pseudo-random in [0,1). Stable across frames (so the
// explosion doesn't jitter), but varied between pieces so it reads as random.
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Split: rebuild the ring as 4 equal quarter-arc segments in ONE merged
// geometry, so a single MeshTransmissionMaterial renders it (identical look to
// the un-split ring). Each segment is scattered like an explosion (deterministic
// fly-off + tumble, scaled by `t`) with the user's spin baked on top. The 4
// segments share an identical topology, so a ray hit's faceIndex maps to a
// segment via floor(faceIndex / (totalFaces / 4)).
function buildSeparatedRing(
  shape: ShapeParams,
  t: number,
  separation: number,
  userSpins: Quaternion[],
  spinFactor: number // scales the user spin (→0 so segments rejoin cleanly)
): BufferGeometry {
  const R = shape.radius;
  const r = Math.max(shape.radius * shape.hole, 1e-3);
  const midR = (R + r) / 2;
  const parts: BufferGeometry[] = [];
  const q = new Quaternion();
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * Math.PI * 2;
    const a1 = ((i + 1) / 4) * Math.PI * 2;
    const bis = (a0 + a1) / 2;

    const seg = new Shape();
    seg.absarc(0, 0, R, a0, a1, false); // outer arc a0 → a1
    seg.absarc(0, 0, r, a1, a0, true); // radial in, inner arc back a1 → a0
    seg.closePath();
    let g: BufferGeometry = new ExtrudeGeometry(seg, {
      depth: shape.depth,
      bevelEnabled: shape.bevel > 0,
      bevelThickness: shape.bevel,
      bevelSize: shape.bevel,
      bevelSegments: BEVEL_SEGMENTS,
      steps: 1,
      curveSegments: 32,
    });
    g.deleteAttribute("uv");
    g.deleteAttribute("normal");
    g = mergeVertices(g);
    g.computeVertexNormals();
    g.translate(0, 0, -shape.depth / 2); // centre in depth

    // Deterministic explosion: outward-biased fly-off + tumble.
    const fdx = Math.cos(bis) + (hash(i * 9 + 1) * 2 - 1) * 0.9;
    const fdy = Math.sin(bis) + (hash(i * 9 + 2) * 2 - 1) * 0.9;
    const fdz = (hash(i * 9 + 3) * 2 - 1) * 0.8;
    const fl = Math.hypot(fdx, fdy, fdz) || 1;
    const dist = separation * t * (0.6 + hash(i * 9 + 4) * 1.1);
    const axis = new Vector3(
      hash(i * 9 + 5) * 2 - 1,
      hash(i * 9 + 6) * 2 - 1,
      hash(i * 9 + 7) * 2 - 1
    );
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    axis.normalize();

    const cx = Math.cos(bis) * midR;
    const cy = Math.sin(bis) * midR;
    const ox = (fdx / fl) * dist;
    const oy = (fdy / fl) * dist;
    const oz = (fdz / fl) * dist;

    // Explosion: tumble about the segment's centre, then fly off.
    q.setFromAxisAngle(axis, (hash(i * 9 + 8) * 2 - 1) * Math.PI * 1.4 * t);
    const m = new Matrix4()
      .makeTranslation(ox, oy, oz)
      .multiply(new Matrix4().makeTranslation(cx, cy, 0))
      .multiply(new Matrix4().makeRotationFromQuaternion(q))
      .multiply(new Matrix4().makeTranslation(-cx, -cy, 0));
    // User spin, about the segment's exploded centre (eased out by spinFactor
    // so the segments reassemble cleanly when rejoining).
    const us = new Quaternion().slerp(userSpins[i], spinFactor);
    m.premultiply(
      new Matrix4()
        .makeTranslation(cx + ox, cy + oy, oz)
        .multiply(new Matrix4().makeRotationFromQuaternion(us))
        .multiply(new Matrix4().makeTranslation(-(cx + ox), -(cy + oy), -oz))
    );
    g.applyMatrix4(m);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

function RingShape({
  glass,
  shape,
  morph,
  runId,
  split,
  setLock,
  sectionRef,
}: {
  glass: GlassProps;
  shape: ShapeParams;
  morph: MorphParams;
  runId: number;
  split: SplitParams;
  setLock: (locked: boolean) => void;
  sectionRef: { readonly current: HTMLElement | null };
}) {
  const spinRef = useRef<Group>(null);
  const floatRef = useRef<Group>(null);
  const orientRef = useRef<Group>(null);
  const swirlRef = useRef<Group>(null);
  const meshRef = useRef<Mesh>(null);
  const geoRef = useRef<BufferGeometry | null>(null);
  // True while the ring is broken into segments (so pointer picks map to a
  // segment); kept in a ref so the pointer handler reads the live value.
  const splitRef = useRef(false);
  // Smoothed scroll-out [0..1] (low-pass filtered for a fluid rejoin).
  const scrollRef = useRef(0);
  // startedAt: clock time the morph timer began. builtP / builtSep / sig: caches
  // so we only rebuild geometry when something actually changed.
  const anim = useRef({ startedAt: -1, builtP: -1, builtSep: -1, sig: "" });

  // Per-segment accumulated user spin, plus which segment is currently grabbed.
  const userSpins = useMemo(
    () => Array.from({ length: 4 }, () => new Quaternion()),
    []
  );
  const drag = useRef<{ i: number } | null>(null);
  // Pointer + per-piece angular velocity (for inertia). Movement is accumulated
  // here and integrated once per frame for smoothness (px/py = last pointer,
  // dx/dy = movement since last frame).
  const motion = useRef({
    px: 0,
    py: 0,
    dx: 0,
    dy: 0,
    vel: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  });
  // Reusable temporaries to avoid per-frame allocation.
  const tmp = useMemo(
    () => ({ q: new Quaternion(), spin: new Quaternion(), e: new Euler() }),
    []
  );

  // (Re)start the morph whenever runId changes; also reset any user spins.
  useEffect(() => {
    if (runId > 0) {
      anim.current.startedAt = -1;
      anim.current.builtP = -1;
      anim.current.builtSep = -1;
      userSpins.forEach((q) => q.identity());
    }
  }, [runId, userSpins]);

  useEffect(() => () => geoRef.current?.dispose(), []);

  // While a piece is grabbed, just accumulate pointer movement; the spin itself
  // is integrated once per frame in useFrame (smoother + lets us add inertia).
  // `lock` tells the whole-model DragToRotate to stand down meanwhile.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return;
      const m = motion.current;
      m.dx += e.clientX - m.px;
      m.dy += e.clientY - m.py;
      m.px = e.clientX;
      m.py = e.clientY;
    };
    const onUp = () => {
      if (drag.current) {
        drag.current = null;
        setLock(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setLock]);

  useFrame((state, delta) => {
    if (spinRef.current) spinRef.current.rotation.y += delta * shape.spin;
    const mesh = meshRef.current;
    if (!mesh) return;
    const a = anim.current;

    // Begin the timer on the frame after the section comes into view.
    if (runId > 0 && a.startedAt < 0) a.startedAt = state.clock.elapsedTime;
    const elapsed = a.startedAt >= 0 ? state.clock.elapsedTime - a.startedAt : -1;

    // Timeline (s from in-view): hold bar · morph · tilt · then split → float.
    let p = 0;
    let tilt = 0;
    let sepP = 0;
    if (elapsed >= 0) {
      p =
        elapsed <= morph.delay
          ? 0
          : Math.min(1, (elapsed - morph.delay) / morph.duration);
      const tiltStart = morph.delay + morph.duration + morph.tiltDelay;
      tilt =
        elapsed <= tiltStart
          ? 0
          : Math.min(1, (elapsed - tiltStart) / morph.tiltDuration);
      if (split.enabled) {
        const sepStart = tiltStart + morph.tiltDuration + split.delay;
        sepP =
          elapsed <= sepStart
            ? 0
            : Math.min(1, (elapsed - sepStart) / split.duration);
      }
    }
    const eased = easeInOutCubic(p);
    const sepT = easeInOutCubic(sepP);
    const splitting = sepT > 0;

    // Scroll-grow: as the section scrolls up out of the viewport, scale the
    // whole exploded cluster up (bigger and bigger); scrolling back shrinks it.
    // The raw scroll position is low-pass filtered + eased so it glides smoothly
    // rather than tracking choppy steps. 0 = in view, 1 = scrolled out.
    let scrollTarget = 0;
    const el = sectionRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      scrollTarget = Math.min(
        1,
        Math.max(0, -rect.top / ((rect.height || 1) * SCROLL_SPAN))
      );
    }
    scrollRef.current +=
      (scrollTarget - scrollRef.current) * Math.min(1, delta * 3.5);
    const bigness = easeInOutCubic(scrollRef.current); // 0 in view → 1 scrolled out
    const sepEff = sepT; // stays exploded; scroll scales it rather than rejoining

    // Tilt the assembly (edge-on → angled up).
    if (orientRef.current)
      orientRef.current.rotation.x =
        Math.PI / 2 - easeInOutCubic(tilt) * ((morph.tilt * Math.PI) / 180);

    // Float once broken apart: spin the cluster around centre, grow, bob. This
    // keeps running even while you spin a piece by hand — your spin just layers
    // on top, so nothing ever freezes.
    if (swirlRef.current) {
      // Orbit while separated. Base scale from the explosion grow, multiplied by
      // the scroll-grow so it swells as you scroll out and shrinks coming back.
      swirlRef.current.rotation.z += delta * split.swirl * sepEff;
      swirlRef.current.scale.setScalar(
        (1 + (split.grow - 1) * sepEff) * (1 + bigness * split.scrollGrow)
      );
    }
    if (floatRef.current) {
      const ts = state.clock.elapsedTime;
      floatRef.current.position.y = Math.sin(ts * 0.5) * split.float * sepEff;
      floatRef.current.rotation.x = Math.sin(ts * 0.27) * 0.04 * sepEff;
      floatRef.current.rotation.z = Math.sin(ts * 0.33) * 0.05 * sepEff;
    }

    splitRef.current = splitting;
    // Only the separated pieces are draggable — the bar / ring before the split
    // can't be manipulated. (Also locked while spinning an individual segment.)
    setLock(!splitting || drag.current !== null);

    // Per-segment spin: integrate accumulated pointer movement once per frame
    // (smooth) plus inertia. `spinning` flags that the geometry must rebuild.
    const dt = Math.min(delta, 1 / 30); // clamp so a frame drop can't lurch it
    const SENS = 0.01;
    const mo = motion.current;
    let spinning = false;
    if (splitting) {
      for (let i = 0; i < 4; i++) {
        const v = mo.vel[i];
        if (drag.current && drag.current.i === i) {
          const rx = mo.dy * SENS;
          const ry = mo.dx * SENS;
          tmp.spin.setFromEuler(tmp.e.set(rx, ry, 0));
          userSpins[i].premultiply(tmp.spin);
          v.x += (rx / dt - v.x) * 0.5;
          v.y += (ry / dt - v.y) * 0.5;
          mo.dx = 0;
          mo.dy = 0;
          spinning = true;
        } else if (Math.abs(v.x) > 1e-4 || Math.abs(v.y) > 1e-4) {
          // Inertia: keep spinning after release, easing to a stop.
          tmp.spin.setFromEuler(tmp.e.set(v.x * dt, v.y * dt, 0));
          userSpins[i].premultiply(tmp.spin);
          const damp = Math.pow(0.95, dt * 60);
          v.x *= damp;
          v.y *= damp;
          spinning = true;
        }
      }
    }

    // ONE mesh throughout (so the segments share the ring's exact material).
    // Rebuild it when the morph progresses, the split progresses, a segment is
    // being spun, or the shape / split params change.
    const sig = `${shape.radius}|${shape.hole}|${shape.depth}|${shape.bevel}|${morph.barWidth}|${morph.barHeight}|${split.separation}`;
    const needRebuild = splitting
      ? a.builtSep < 0 ||
        Math.abs(sepEff - a.builtSep) > 0.0004 ||
        spinning ||
        sig !== a.sig
      : Math.abs(eased - a.builtP) > 0.0008 || sig !== a.sig;
    if (needRebuild) {
      const geo = splitting
        ? buildSeparatedRing(shape, sepEff, split.separation, userSpins, 1)
        : buildGeometry(eased, shape, morph);
      geoRef.current?.dispose();
      geoRef.current = geo;
      mesh.geometry = geo;
      a.builtP = eased;
      a.builtSep = splitting ? sepEff : -1;
      a.sig = sig;
    }
  });

  return (
    <group ref={spinRef}>
      {/* float: gentle bob / wobble of the whole cluster once it's drifting. */}
      <group ref={floatRef}>
        {/* orient: edge-on (π/2) → angled-up tilt, driven in useFrame. */}
        <group ref={orientRef}>
          {/* swirl: continuous spin around the centre axis + grow, after split. */}
          <group ref={swirlRef}>
            {/* ONE mesh for the whole sequence (bar → ring → exploded segments)
                so the segments share the ring's exact MeshTransmissionMaterial.
                Geometry is rebuilt in useFrame; a pointer pick maps the hit face
                to a segment, then dragging spins just that segment. */}
            <mesh
              ref={meshRef}
              onPointerDown={(e) => {
                const geom = meshRef.current?.geometry;
                if (!splitRef.current || !geom?.index || e.faceIndex == null)
                  return;
                e.stopPropagation();
                drag.current = {
                  i: Math.min(3, Math.floor(e.faceIndex / (geom.index.count / 12))),
                };
                motion.current.px = e.clientX;
                motion.current.py = e.clientY;
                motion.current.dx = 0;
                motion.current.dy = 0;
                setLock(true);
              }}
            >
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
        </group>
      </group>
    </group>
  );
}

export default function SectionSix() {
  // Own Leva store so this scene's panel doesn't collide with other sections'.
  const store = useCreateStore();

  // runId drives the morph: 0 = idle (solid bar), bumped to start / replay it.
  const [runId, setRunId] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  // True while a segment is being spun by hand, so the whole-model drag stands
  // down. RingShape flips it through a stable setter (it can't mutate the ref
  // directly as a prop).
  const lockRef = useRef(false);
  const setLock = useCallback((locked: boolean) => {
    lockRef.current = locked;
  }, []);

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
      delay: { value: 1.8, min: 0, max: 10, step: 0.1 },
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

  // After the tilt, break the ring into 4 equal quarter-arcs and spread them.
  const split = useControls(
    "Split",
    {
      enabled: true,
      separation: { value: 0.6, min: 0, max: 3, step: 0.05 },
      // Measured from when the tilt ends — negative starts the split early so it
      // begins just before the tilt finishes (overlapping its tail).
      delay: { value: -0.3, min: -2, max: 5, step: 0.1 },
      duration: { value: 1.2, min: 0.2, max: 5, step: 0.1 },
      // Floating motion once broken apart:
      swirl: { value: 0.3, min: -2, max: 2, step: 0.05 }, // orbit speed (rad/s)
      grow: { value: 1.35, min: 1, max: 3, step: 0.05 }, // how much bigger
      float: { value: 0.08, min: 0, max: 0.5, step: 0.01 }, // bob amount
      // How much bigger the cluster grows as you scroll out of the section.
      scrollGrow: { value: 1.2, min: 0, max: 5, step: 0.1 },
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
        <LevaPanel
          store={store}
          fill
          flat
          collapsed
          titleBar={{ title: "Shape" }}
        />
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
          {/* resetDelay=Infinity → never eases back; stays where you drag it. */}
          <DragToRotate resetDelay={Infinity} lock={lockRef}>
            <RingShape
              glass={glass}
              shape={shape}
              morph={morph}
              runId={runId}
              split={split}
              setLock={setLock}
              sectionRef={sectionRef}
            />
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
