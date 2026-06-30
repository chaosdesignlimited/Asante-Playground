"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { Group, Mesh, BufferGeometry } from "three";
import { Shape, ExtrudeGeometry, NeutralToneMapping } from "three";
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
  chromaticAberration: number;
  distortion: number;
  distortionScale: number;
  temporalDistortion: number;
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
  hollow: boolean;
  wall: number;
};

type StackParams = {
  animate: boolean;
  delay: number;
  rotateYDuration: number;
  rotateXDuration: number;
  splitDelay: number;
  splitDuration: number;
  thickness: number;
  gap: number;
  barThickness: number;
};

type FloatParams = {
  floating: boolean;
  amplitude: number;
  speed: number;
};

// ── Bar geometry ────────────────────────────────────────────────────────────
// Static solid bar that splits depth-wise into 4 thin layers, then holds. The
// animation ends once the split completes.

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

// Flip a geometry inside-out: reverse winding and negate normals. Used for the
// inner wall of a hollow block so its surface faces into the cavity.
function invertGeometry(geo: BufferGeometry) {
  const index = geo.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      index.setX(i, index.getX(i + 2));
      index.setX(i + 2, a);
    }
    index.needsUpdate = true;
  }
  const normal = geo.getAttribute("normal");
  if (normal) {
    for (let i = 0; i < normal.count; i++) {
      normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
    }
    normal.needsUpdate = true;
  }
}

// A solid block (extruded rectangle) centred on the origin.
function solidBlock(
  W: number,
  H: number,
  thick: number,
  bevel: number
): BufferGeometry {
  const g = extrudeRect(W, H, thick, bevel);
  g.translate(0, 0, -thick / 2);
  return g;
}

// A hollow block: an outer shell with an inner cavity inset by `wall` on every
// face. The inner surface is flipped so the wall reads as thin glass you can see
// into. Falls back to solid if the wall leaves no cavity.
function buildHollowBlock(
  W: number,
  H: number,
  thick: number,
  bevel: number,
  wall: number
): BufferGeometry {
  const outer = solidBlock(W, H, thick, bevel);
  const iw = W - 2 * wall;
  const ih = H - 2 * wall;
  const it = thick - 2 * wall;
  if (iw <= 0 || ih <= 0 || it <= 0) return outer;
  const inner = solidBlock(iw, ih, it, 0);
  invertGeometry(inner);
  const shell = mergeGeometries([outer, inner], false);
  outer.dispose();
  inner.dispose();
  return shell;
}

const DEG = Math.PI / 180;
const LAYERS = [0, 1, 2, 3];

// Press-and-hold: gaps compress smoothly while held, then spring back with
// elasticity on release before settling into the breathing.
const PRESS_STIFFNESS = 170;
const PRESS_DAMP_IN = 26; // ~critically damped → smooth compress, no bounce in
const PRESS_DAMP_OUT = 9; // underdamped → elastic spring-back on release
const PRESS_COMPRESS = 0.8; // fraction of the gap that closes when fully pressed

function Bar({
  glass,
  bar,
  stack,
  rotation,
  float,
  pressRef,
  runId,
}: {
  glass: GlassProps;
  bar: BarParams;
  stack: StackParams;
  rotation: { rotateX: number; rotateY: number; rotateZ: number };
  float: FloatParams;
  pressRef: { current: boolean };
  runId: number;
}) {
  const introRef = useRef<Group>(null);
  const barRef = useRef<Mesh>(null);
  const meshRefs = useRef<(Mesh | null)[]>([]);
  const geoRef = useRef<BufferGeometry | null>(null);
  const barGeoRef = useRef<BufferGeometry | null>(null);
  const anim = useRef({
    startedAt: -1,
    sig: "",
    barSig: "",
    press: 0, // eased compression amount (0 = default, 1 = fully pressed)
    pressVel: 0, // spring velocity
  });

  useEffect(() => {
    if (runId > 0) anim.current.startedAt = -1;
  }, [runId]);

  useEffect(
    () => () => {
      geoRef.current?.dispose();
      barGeoRef.current?.dispose();
    },
    []
  );

  useFrame((state, delta) => {
    const a = anim.current;
    if (runId > 0 && a.startedAt < 0) a.startedAt = state.clock.elapsedTime;

    // Animation off: hold the final composed pose (fully rotated + split) so the
    // material can be tuned on a still shape. On: hold · rotate Y · rotate X ·
    // split · stop.
    let yE = 1;
    let xE = 1;
    let split = 1;
    if (stack.animate) {
      const yEnd = stack.delay + stack.rotateYDuration;
      const xEnd = yEnd + stack.rotateXDuration;
      const splitStart = xEnd + stack.splitDelay;

      let yP = 0;
      let xP = 0;
      let splitP = 0;
      if (a.startedAt >= 0) {
        const elapsed = state.clock.elapsedTime - a.startedAt;
        yP = Math.min(1, Math.max(0, (elapsed - stack.delay) / stack.rotateYDuration));
        xP = Math.min(1, Math.max(0, (elapsed - yEnd) / stack.rotateXDuration));
        splitP = Math.min(
          1,
          Math.max(0, (elapsed - splitStart) / stack.splitDuration)
        );
      }
      yE = easeInOutCubic(yP);
      xE = easeInOutCubic(xP);
      split = easeInOutCubic(splitP);
    }

    // Ease rotateY (and rotateZ) in first, then rotateX, toward the target pose
    // set in the Rotation panel.
    if (introRef.current) {
      introRef.current.rotation.y = yE * rotation.rotateY * DEG;
      introRef.current.rotation.z = yE * rotation.rotateZ * DEG;
      introRef.current.rotation.x = xE * rotation.rotateX * DEG;
    }

    // Before the split it's one solid bar (4 separate plates would show seams
    // and look pre-stacked). The instant it starts splitting we swap to the 4
    // plates so it reads as one shape cracking apart — and each plate's glass
    // can then see through the others.
    const { width: W, height: H, depth: D, bevel, hollow, wall } = bar;
    const quarter = D / 4;
    const thick = quarter * (1 - split) + stack.thickness * split;
    const spacing = quarter * (1 - split) + (stack.thickness + stack.gap) * split;
    const splitting = split > 0;

    // Solid bar geometry (full depth) — rebuilt only when the shape changes.
    const barSig = `${W}|${H}|${D}|${bevel}|${hollow}|${wall}`;
    if (barSig !== a.barSig) {
      const bg =
        hollow && wall > 0
          ? buildHollowBlock(W, H, D, bevel, wall)
          : solidBlock(W, H, D, bevel);
      barGeoRef.current?.dispose();
      barGeoRef.current = bg;
      if (barRef.current) barRef.current.geometry = bg;
      a.barSig = barSig;
    }
    if (barRef.current) barRef.current.visible = !splitting;

    // Plate geometry — all 4 share it; rebuilt as the thickness changes.
    const sig = `${W}|${H}|${bevel}|${hollow}|${wall}|${thick.toFixed(4)}`;
    if (sig !== a.sig) {
      const geo =
        hollow && wall > 0
          ? buildHollowBlock(W, H, thick, bevel, wall)
          : solidBlock(W, H, thick, bevel);
      geoRef.current?.dispose();
      geoRef.current = geo;
      for (const m of meshRefs.current) if (m) m.geometry = geo;
      a.sig = sig;
    }

    // Press-and-hold spring driving the gap compression. Critically damped while
    // held (smooth compress, no bounce); underdamped on release (elastic
    // spring-back that overshoots and settles).
    const dt = Math.min(delta, 1 / 30);
    const pressTarget = pressRef.current ? 1 : 0;
    const damp = pressTarget === 1 ? PRESS_DAMP_IN : PRESS_DAMP_OUT;
    a.pressVel +=
      ((pressTarget - a.press) * PRESS_STIFFNESS - a.pressVel * damp) * dt;
    a.press += a.pressVel * dt;

    // Very subtle "breathing": the spacing oscillates a touch so the gaps grow
    // and shrink together. Pressing closes the gaps on top of that.
    const t = state.clock.elapsedTime;
    const breathe = float.floating
      ? Math.sin(t * float.speed) * float.amplitude
      : 0;
    const effSpacing = spacing - stack.gap * PRESS_COMPRESS * a.press + breathe;
    for (let layer = 0; layer < 4; layer++) {
      const m = meshRefs.current[layer];
      if (!m) continue;
      m.visible = splitting;
      m.position.set(0, 0, (layer - 1.5) * effSpacing);
    }
  });

  return (
    <group ref={introRef}>
      {/* Base orientation; plates spread along local z, which this turns into a
          vertical stack. Each plate is its own mesh + transmission material. */}
      <group rotation-x={Math.PI / 2}>
        {/* One solid bar, shown until the split begins. Same glass as the
            plates, but a lighter `thickness` so the thick block doesn't read
            as solid. */}
        <mesh ref={barRef}>
          <MeshTransmissionMaterial
            {...glass}
            thickness={stack.barThickness}
            resolution={512}
            backsideResolution={512}
          />
        </mesh>
        {LAYERS.map((layer) => (
          <mesh
            key={layer}
            visible={false}
            ref={(el) => {
              meshRefs.current[layer] = el;
            }}
          >
            <MeshTransmissionMaterial
              {...glass}
              resolution={512}
              backsideResolution={512}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

export default function FourFloatingBlocks() {
  const store = useCreateStore();
  const [runId, setRunId] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  // True while the left mouse button is held down in the section — read by the
  // Bar's spring loop to compress the gaps.
  const pressRef = useRef(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const down = (e: MouseEvent) => {
      if (e.button === 0) pressRef.current = true;
    };
    const up = () => {
      pressRef.current = false;
    };
    el.addEventListener("mousedown", down);
    // Release on window so it still fires if the cursor leaves the section.
    window.addEventListener("mouseup", up);
    return () => {
      el.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
    };
  }, []);

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
      height: { value: 0.8, min: 0.05, max: 2, step: 0.05 },
      depth: { value: 0.45, min: 0.01, max: 5, step: 0.01 },
      bevel: { value: 0.02, min: 0, max: 0.3, step: 0.01 },
      // Solid plates read like the flat glass swatches; flip on for hollow shells.
      hollow: false,
      // Wall thickness in scene units — small reads like ~1mm glass.
      wall: { value: 0.01, min: 0, max: 0.1, step: 0.001 },
    },
    { store }
  );

  const stack = useControls(
    "Stack",
    {
      animate: false,
      delay: { value: 0.4, min: 0, max: 5, step: 0.1 },
      rotateYDuration: { value: 0.8, min: 0.1, max: 4, step: 0.1 },
      rotateXDuration: { value: 0.8, min: 0.1, max: 4, step: 0.1 },
      splitDelay: { value: 0.2, min: 0, max: 3, step: 0.1 },
      splitDuration: { value: 1.0, min: 0.2, max: 5, step: 0.1 },
      thickness: { value: 0.015, min: 0.005, max: 0.3, step: 0.005 },
      gap: { value: 0.15, min: 0, max: 0.5, step: 0.01 },
      // Glass thickness for the pre-split solid bar only — lower = lighter, less
      // solid-looking. The plates keep the Glass-panel thickness.
      barThickness: { value: 0.1, min: 0, max: 1, step: 0.01 },
      Replay: button(() => setRunId((r) => r + 1)),
    },
    { store }
  );

  const rotation = useControls(
    "Rotation",
    {
      rotateX: { value: 16, min: -180, max: 180, step: 1 },
      rotateY: { value: 41, min: -180, max: 180, step: 1 },
      rotateZ: { value: 0, min: -180, max: 180, step: 1 },
    },
    { store }
  );

  const float = useControls(
    "Float",
    {
      floating: true,
      // How much the gaps breathe (scene units). Keep tiny — just a hint.
      amplitude: { value: 0.013, min: 0, max: 0.1, step: 0.001 },
      speed: { value: 0.4, min: 0, max: 2, step: 0.05 },
    },
    { store }
  );

  const glass = useControls(
    "Glass",
    {
      // White base keeps it reading as clear glass — a saturated base colour
      // paints the surface and looks solid. The orange comes from the volumetric
      // attenuation below (light tinting as it passes through), not the base.
      color: "#ffffff",
      transmission: { value: 1, min: 0, max: 1, step: 0.01 },
      // Lower thickness = less refraction displacement, so the slab behind stays
      // recognisable through the one in front.
      thickness: { value: 0.2, min: 0, max: 5, step: 0.05 },
      ior: { value: 1.5, min: 1, max: 2.33, step: 0.01 },
      // Low roughness for clean, glossy slabs like the reference (not frosted).
      roughness: { value: 0.05, min: 0, max: 1, step: 0.01 },
      // Surface texture: distortion ripples the glass like the reference swatches;
      // chromatic aberration adds the prismatic colour at the edges.
      texture: folder(
        {
          chromaticAberration: { value: 0.04, min: 0, max: 0.5, step: 0.01 },
          distortion: { value: 0.1, min: 0, max: 1, step: 0.01 },
          distortionScale: { value: 0.4, min: 0, max: 1, step: 0.01 },
          temporalDistortion: { value: 0, min: 0, max: 1, step: 0.01 },
        },
        { collapsed: true }
      ),
      hollow: folder(
        {
          // Backside re-projects the geometry onto the flat faces, which on these
          // stacked plates reads as each block mirroring itself top and bottom.
          // Off by default now that the blocks have real inner walls.
          backside: false,
          backsideThickness: { value: 0.1, min: 0, max: 5, step: 0.05 },
          anisotropicBlur: { value: 0, min: 0, max: 2, step: 0.01 },
          samples: { value: 10, min: 1, max: 32, step: 1 },
        },
        { collapsed: true }
      ),
      absorption: folder(
        {
          attenuationColor: "#FF7234",
          // Balance dial: too low and the orange gets so dense you can't see the
          // slab behind; too high and it goes pale. Aim for rich-but-transmissive.
          attenuationDistance: { value: 0.8, min: 0.1, max: 10, step: 0.1 },
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

  const {
    preset,
    environmentIntensity,
    envRotX,
    envRotY,
    envRotZ,
    background,
  } = useControls(
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
      environmentIntensity: { value: 1.6, min: 0, max: 4, step: 0.1 },
      // Rotating the environment is the real "lighting angle" for glass — the
      // transmission material is lit by the env map, not the direct light.
      // Front/top key for bright, clean studio highlights.
      envRotX: { value: 50, min: -180, max: 180, step: 1 },
      envRotY: { value: 25, min: -180, max: 180, step: 1 },
      envRotZ: { value: 0, min: -180, max: 180, step: 1 },
      background: "#F2F2F3",
    },
    { store }
  );

  return (
    <section
      ref={sectionRef}
      className="relative h-screen w-screen overflow-hidden bg-[#F8F6F3] text-[#0D2728]"
    >
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
        // Perspective lens so the stacked slabs foreshorten and recede.
        camera={{ position: [0, 0, 9], fov: 28 }}
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
              rotation={rotation}
              float={float}
              pressRef={pressRef}
              runId={runId}
            />
          </DragToRotate>
          <Environment
            preset={preset as ComponentProps<typeof Environment>["preset"]}
            environmentIntensity={environmentIntensity}
            environmentRotation={[envRotX * DEG, envRotY * DEG, envRotZ * DEG]}
          />
        </Suspense>
      </Canvas>

      {/* Title sits just above where the bar rests. */}
      <h1 className="pointer-events-none absolute left-1/2 top-[43%] z-10 -translate-x-1/2 -translate-y-full text-center text-4xl font-semibold tracking-tight text-[#0D2728] md:text-6xl">
        Beyond the benchmark<span className="text-[#FF7234]">.</span>
      </h1>
    </section>
  );
}
