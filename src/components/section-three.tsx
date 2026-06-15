"use client";

import { Suspense, useMemo } from "react";
import type { ComponentProps } from "react";
import type { Mesh, BufferGeometry } from "three";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Bounds,
  Environment,
  ContactShadows,
  useGLTF,
} from "@react-three/drei";
import { Leva, useControls, folder } from "leva";

const MODEL_URL = "/model/orange_glass_block.glb";

type MaterialProps = {
  color: string;
  opacity: number;
  roughness: number;
  metalness: number;
  ior: number;
  clearcoat: number;
  clearcoatRoughness: number;
};

function ResinBlock({ material }: { material: MaterialProps }) {
  const { scene } = useGLTF(MODEL_URL);

  // Reuse the block geometry, rendered as one solid translucent resin volume
  // (no hollow cavity, no liquid) — just a colored, refractive solid.
  const geometry = useMemo(() => {
    let geo: BufferGeometry | undefined;
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh && !geo) geo = mesh.geometry;
    });
    return geo;
  }, [scene]);

  return (
    <Bounds fit clip observe margin={2}>
      <mesh geometry={geometry}>
        {/* Orange resin as a real alpha-blended solid: `opacity` genuinely fades
            it (no transmission path overriding the alpha). Driven live by leva. */}
        <meshPhysicalMaterial transparent {...material} />
      </mesh>
    </Bounds>
  );
}

// Preload so the model is ready as soon as the section mounts.
useGLTF.preload(MODEL_URL);

export default function SectionThree() {
  // Live-tunable material. Drag these in the panel; the block updates instantly.
  const material = useControls("Resin material", {
    color: "#FF7234",
    opacity: { value: 0.6, min: 0, max: 1, step: 0.01 },
    roughness: { value: 0.15, min: 0, max: 1, step: 0.01 },
    ior: { value: 1.5, min: 1, max: 2.33, step: 0.01 },
    sheen: folder(
      {
        metalness: { value: 0, min: 0, max: 1, step: 0.01 },
        clearcoat: { value: 1, min: 0, max: 1, step: 0.01 },
        clearcoatRoughness: { value: 0.1, min: 0, max: 1, step: 0.01 },
      },
      { collapsed: true }
    ),
  });

  // Lighting/scene controls — these drive how "glassy" the surface reads.
  const { preset, environmentIntensity, background } = useControls("Scene", {
    preset: {
      value: "apartment",
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
    environmentIntensity: { value: 1.4, min: 0, max: 4, step: 0.1 },
    background: "#F8F6F3",
  });

  return (
    <section className="relative h-screen w-screen bg-[#F8F6F3] text-[#0D2728]">
      <Leva collapsed={false} />
      <Canvas
        camera={{ position: [0, 0, 4], fov: 45 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        {/* Scene background — transmission/reflections sample THIS, not the CSS
            background, so it must be light for the resin to read clearly. */}
        <color attach="background" args={[background]} />

        {/* Natural, soft lighting driven mostly by the environment. */}
        <ambientLight intensity={0.3} />
        <directionalLight position={[-4, 6, 4]} intensity={0.5} />
        <directionalLight position={[6, 2, -3]} intensity={0.15} />

        <Suspense fallback={null}>
          <ResinBlock material={material} />
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

        {/* Slow auto-spin; drag still works. Zoom disabled so the wheel scrolls. */}
        <OrbitControls
          makeDefault
          enableDamping
          enableZoom={false}
          autoRotate
          autoRotateSpeed={0.6}
        />
      </Canvas>

      <p className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-sm opacity-50">
        Orange resin · drag to rotate · tune the finish in the panel →
      </p>
    </section>
  );
}
