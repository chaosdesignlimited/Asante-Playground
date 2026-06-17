"use client";

import { Suspense, useMemo, useRef } from "react";
import type { ComponentProps } from "react";
import type { Mesh, Group } from "three";
import { Vector3, Quaternion, NeutralToneMapping } from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  Bounds,
  Environment,
  ContactShadows,
  useGLTF,
} from "@react-three/drei";
import { LevaPanel, useControls, useCreateStore, folder } from "leva";
import DragToRotate from "./drag-to-rotate";

const MODEL_URL = "/model/orange_glass_block.glb";

type GlassProps = {
  color: string;
  opacity: number;
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  ior: number;
};

type WaveProps = {
  amplitude: number;
  speed: number;
  gap: number;
  spin: number;
};

function GlassBlocks({ glass, wave }: { glass: GlassProps; wave: WaveProps }) {
  const { scene } = useGLTF(MODEL_URL);
  const spin = useRef<Group>(null);
  const meshRefs = useRef<(Mesh | null)[]>([]);

  // Collect every block in the model (the GLB holds 4: Block_1..Block_4),
  // each rendered as a real refractive glass volume. We keep each block's own
  // world transform so they stay in their original arrangement, and tag each
  // with its slot in the wave by sorting along the stacking axis (Z).
  const blocks = useMemo(() => {
    scene.updateMatrixWorld(true);
    const out: {
      uuid: string;
      geometry: Mesh["geometry"];
      position: Vector3;
      quaternion: Quaternion;
      scale: Vector3;
      order: number;
    }[] = [];
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      mesh.matrixWorld.decompose(position, quaternion, scale);
      // Slabs are baked at the origin; their depth lives in the geometry, so use
      // the geometry's Z center to order the wave front→back.
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      const order = bb ? (bb.min.z + bb.max.z) / 2 : 0;
      out.push({ uuid: mesh.uuid, geometry: mesh.geometry, position, quaternion, scale, order });
    });
    out.sort((a, b) => b.order - a.order);
    return out;
  }, [scene]);

  // Spin the whole group, and run the Mexican wave by lifting each slab's Y on a
  // phase offset by its position in the line — so the bump travels along the row.
  useFrame((state, delta) => {
    if (spin.current) spin.current.rotation.y += delta * wave.spin;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < blocks.length; i++) {
      const mesh = meshRefs.current[i];
      if (!mesh) continue;
      const phase = t * wave.speed - i * wave.gap;
      // max(0, sin) ⇒ each slab rises and falls once, then rests until the
      // wave comes back around — the classic stadium-wave pulse.
      mesh.position.y = wave.amplitude * Math.max(0, Math.sin(phase));
    }
  });

  return (
    <Bounds fit clip observe margin={2}>
      <group ref={spin}>
        {blocks.map((block, i) => (
          <mesh
            key={block.uuid}
            ref={(el) => {
              meshRefs.current[i] = el;
            }}
            geometry={block.geometry}
            position={block.position}
            quaternion={block.quaternion}
            scale={block.scale}
          >
            {/* Orange translucent glass: alpha-blended so overlapping slabs
                deepen toward red. Clearcoat adds the glossy surface sheen. */}
            <meshPhysicalMaterial transparent {...glass} />
          </mesh>
        ))}
      </group>
    </Bounds>
  );
}

// Preload so the model is ready as soon as the section mounts.
useGLTF.preload(MODEL_URL);

export default function SectionThree() {
  // Own Leva store so this scene's panel doesn't collide with other sections'.
  const store = useCreateStore();

  // Live-tunable glass. Drag these in the panel; the blocks update instantly.
  const glass = useControls(
    "Glass",
    {
      // Orange translucent glass — overlaps build toward a deeper red. Glossy
      // via clearcoat. (Style-guide match with the section below.)
      color: "#f0703f",
      opacity: { value: 0.5, min: 0, max: 1, step: 0.01 },
      roughness: { value: 0.12, min: 0, max: 1, step: 0.01 },
      ior: { value: 1.5, min: 1, max: 2.33, step: 0.01 },
      sheen: folder(
        {
          metalness: { value: 0, min: 0, max: 1, step: 0.01 },
          clearcoat: { value: 1, min: 0, max: 1, step: 0.01 },
          clearcoatRoughness: { value: 0.12, min: 0, max: 1, step: 0.01 },
        },
        { collapsed: true }
      ),
    },
    { store }
  );

  // Mexican-wave animation. `gap` is the phase offset between neighbouring
  // slabs; `spin` is the slow turntable rotation (rad/s).
  const wave = useControls(
    "Wave",
    {
      amplitude: { value: 0.45, min: 0, max: 1.5, step: 0.01 },
      speed: { value: 2.5, min: 0, max: 8, step: 0.1 },
      gap: { value: 0.9, min: 0, max: Math.PI, step: 0.01 },
      spin: { value: 0.3, min: 0, max: 2, step: 0.05 },
    },
    { store }
  );

  // Neutral, bright key light — the orange comes from the material now.
  const { lightColor, lightIntensity } = useControls(
    "Lighting",
    {
      lightColor: "#ffffff",
      lightIntensity: { value: 2, min: 0, max: 10, step: 0.1 },
    },
    { store }
  );

  // Environment/background — what the glass reflects and refracts.
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
      environmentIntensity: { value: 1.0, min: 0, max: 4, step: 0.1 },
      background: "#F8F6F3",
    },
    { store }
  );

  return (
    <section className="relative h-screen w-screen bg-[#F8F6F3] text-[#0D2728]">
      <div className="absolute right-3 top-3 z-10 w-72">
        <LevaPanel store={store} fill flat titleBar={{ title: "Wave" }} />
      </div>
      <Canvas
        camera={{ position: [0, 0, 4], fov: 45 }}
        // Neutral tone mapping keeps the orange saturated; ACES (the default)
        // would push the bright highlights toward white.
        gl={{ antialias: true, toneMapping: NeutralToneMapping }}
        dpr={[1, 2]}
      >
        {/* Scene background — transmission/reflections sample THIS, not the CSS
            background, so it must be light for the glass to read clearly. */}
        <color attach="background" args={[background]} />

        {/* Neutral key light. Directional ⇒ parallel rays, so every slab is lit
            the same. The Environment adds the soft reflections. */}
        <directionalLight
          position={[3, 5, 4]}
          intensity={lightIntensity}
          color={lightColor}
        />

        <Suspense fallback={null}>
          {/* Drag rotates the MODEL (camera/lighting stay put); 1.5s after you
              let go it eases back to the default orientation. */}
          <DragToRotate resetDelay={1500}>
            <GlassBlocks glass={glass} wave={wave} />
          </DragToRotate>
          <Environment
            preset={preset as ComponentProps<typeof Environment>["preset"]}
            environmentIntensity={environmentIntensity}
          />
          <ContactShadows
            position={[0, -1.1, 0]}
            opacity={0.28}
            scale={11}
            blur={3.2}
            far={4}
          />
        </Suspense>
      </Canvas>

      <p className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-sm opacity-50">
        Orange glass · drag to rotate the model · tune the finish in the panel →
      </p>
    </section>
  );
}
