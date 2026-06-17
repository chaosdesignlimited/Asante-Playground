"use client";

import { Suspense, useMemo } from "react";
import { BackSide } from "three";
import type { Mesh, BufferGeometry } from "three";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Bounds,
  Environment,
  ContactShadows,
  useGLTF,
} from "@react-three/drei";

const MODEL_URL = "/model/orange_glass_block.glb";

// Outer block is 3 × 0.85 × 1 (from the .glb bounds). Derive the inner cavity
// by insetting a single uniform wall thickness on every side, so the glass is
// equally thick all the way around (incl. the square ends).
const OUTER_SIZE: [number, number, number] = [3, 0.85, 1];
const WALL = 0.00125; // uniform glass wall thickness on every face
const CAVITY_SIZE: [number, number, number] = [
  OUTER_SIZE[0] - WALL * 2,
  OUTER_SIZE[1] - WALL * 2,
  OUTER_SIZE[2] - WALL * 2,
];

// Orange liquid filling the lower part of the cavity. Sized just inside the
// cavity walls, with a height = FILL fraction of the cavity, sitting on the floor.
const FILL = 1.0; // how full the box is (0–1)
const LIQUID_INSET = 0.001; // keep the liquid just inside the glass walls
const LIQUID_HEIGHT = CAVITY_SIZE[1] * FILL - LIQUID_INSET;
const LIQUID_SIZE: [number, number, number] = [
  CAVITY_SIZE[0] - LIQUID_INSET,
  LIQUID_HEIGHT,
  CAVITY_SIZE[2] - LIQUID_INSET,
];
// Rest just above the floor; centred when full.
const LIQUID_Y = -CAVITY_SIZE[1] / 2 + LIQUID_INSET / 2 + LIQUID_HEIGHT / 2;

function GlassBlock() {
  const { scene } = useGLTF(MODEL_URL);

  // Pull the raw geometry out of the loaded .glb so we can render it with our
  // own clear-glass material instead of the baked-in orange one.
  const geometry = useMemo(() => {
    let geo: BufferGeometry | undefined;
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh && !geo) geo = mesh.geometry;
    });
    return geo;
  }, [scene]);

  // Bounds auto-frames + centers the model. margin ~2 leaves the block taking
  // up roughly half the viewport width; `observe` re-fits on resize.
  return (
    <Bounds fit clip observe margin={2}>
      <group>
        {/* Model shell — solid orange with a glossy clearcoat. Low roughness +
            clearcoat give it sharp reflections so the scene lighting/environment
            visibly catches the surface, but it stays opaque (no transmission),
            so it reads as a polished solid rather than see-through glass. */}
        <mesh geometry={geometry}>
          <meshPhysicalMaterial
            color="#FF7234"
            roughness={0.15}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.1}
          />
        </mesh>

        {/* Inner box = the empty cavity. It is deliberately NOT a transmission
            material — three.js hides transmissive meshes from each other's
            refraction buffer, so a faint reflective shell is what actually shows
            THROUGH the outer glass, reading as a hollow box you can see into. */}
        <mesh>
          <boxGeometry args={CAVITY_SIZE} />
          <meshPhysicalMaterial
            side={BackSide}
            transparent
            opacity={0.05}
            roughness={0}
            metalness={0}
            ior={1.45}
            color="#ffffff"
          />
        </mesh>

        {/* Orange liquid. Translucent (opacity < 1) so you can see through it,
            but NOT a transmission material so it stays visible through the outer
            glass. Emissive keeps the orange vibrant under the dimmed lighting. */}
        <mesh position={[0, LIQUID_Y, 0]}>
          <boxGeometry args={LIQUID_SIZE} />
          <meshPhysicalMaterial
            color="#FF7234"
            emissive="#FF7234"
            emissiveIntensity={0.35}
            toneMapped={false}
            roughness={0.1}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.1}
            transmission={0}
            transparent
            opacity={0.95}
          />
        </mesh>
      </group>
    </Bounds>
  );
}

// Preload so the model is ready as soon as the section mounts.
useGLTF.preload(MODEL_URL);

export default function SectionTwo() {
  return (
    <section className="relative h-screen w-screen bg-[#F8F6F3] text-[#0D2728]">
      <Canvas
        camera={{ position: [0, 0, 4], fov: 45 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        {/* Scene background — three.js transmission/reflections sample THIS, not
            the CSS background, so it must be light for the glass to look clear. */}
        <color attach="background" args={["#F8F6F3"]} />

        {/* Natural lighting: lean on the environment (image-based light) with
            just a soft key from the upper-left, rather than hard direct lamps. */}
        <ambientLight intensity={0.3} />
        <directionalLight position={[-4, 6, 4]} intensity={0.5} />
        <directionalLight position={[6, 2, -3]} intensity={0.15} />

        <Suspense fallback={null}>
          <GlassBlock />
          {/* A warm, natural indoor environment drives most of the lighting and
              the soft reflections on the glass. */}
          <Environment preset="apartment" environmentIntensity={1.4} />
          <ContactShadows
            position={[0, -1.1, 0]}
            opacity={0.28}
            scale={11}
            blur={3.2}
            far={4}
          />
        </Suspense>

        {/* Slow auto-spin; drag still works (it resumes after release).
            Zoom disabled so the mouse wheel scrolls the page instead. */}
        <OrbitControls
          makeDefault
          enableDamping
          enableZoom={false}
          autoRotate
          autoRotateSpeed={0.6}
        />
      </Canvas>

      <p className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-sm opacity-50">
        Drag to rotate · scroll to continue
      </p>
    </section>
  );
}
