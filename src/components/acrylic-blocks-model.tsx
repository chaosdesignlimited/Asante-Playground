"use client";

import { Suspense } from "react";
import type { ComponentProps } from "react";
import type { Mesh } from "three";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { Canvas } from "@react-three/fiber";
import {
  Bounds,
  Environment,
  MeshTransmissionMaterial,
  useGLTF,
} from "@react-three/drei";
import { LevaPanel, useControls, useCreateStore } from "leva";
import DragToRotate from "./drag-to-rotate";

const MODEL_URL = "/model/model.glb";
const SLABS = ["Slab_1", "Slab_2", "Slab_3", "Slab_4"];

type Tunables = {
  thickness: number;
  roughness: number;
  attenuationColor: string;
  attenuationDistance: number;
  envMapIntensity: number;
};

function Blocks({ tune }: { tune: Tunables }) {
  const { nodes } = useGLTF(MODEL_URL);
  // Each slab is its own MeshTransmissionMaterial (a MeshPhysicalMaterial under
  // the hood) so the glass can see through to the slabs behind it.
  return (
    <>
      {SLABS.map((name) => {
        const mesh = nodes[name] as Mesh | undefined;
        if (!mesh) return null;
        return (
          <mesh
            key={name}
            geometry={mesh.geometry}
            position={mesh.position}
            rotation={mesh.rotation}
            scale={mesh.scale}
          >
            {/* drei MeshTransmissionMaterial — higher-res sampler + backside so
                stacked slabs see through each other without going dark/muddy. */}
            <MeshTransmissionMaterial
              transmission={1}
              ior={1.45}
              roughness={tune.roughness}
              thickness={tune.thickness}
              color="#F58A3C"
              attenuationColor={tune.attenuationColor}
              attenuationDistance={tune.attenuationDistance}
              envMapIntensity={tune.envMapIntensity}
              chromaticAberration={0}
              distortion={0}
              resolution={1024}
              backside={true}
              backsideResolution={1024}
              samples={8}
            />
          </mesh>
        );
      })}
    </>
  );
}

export default function AcrylicBlocksModel() {
  const store = useCreateStore();
  const tune = useControls(
    "Acrylic",
    {
      // Lower thickness = less absorbed per slab → lighter / more see-through.
      thickness: { value: 0.1, min: 0, max: 3, step: 0.05 },
      // Lower = glossier, sharper reflections.
      roughness: { value: 0.03, min: 0, max: 1, step: 0.01 },
      // Brighter orange so deep overlap paths stay orange instead of browning.
      attenuationColor: "#F7913A",
      // High so light survives the thick centre / overlaps and stays orange.
      attenuationDistance: { value: 35, min: 0.1, max: 40, step: 0.1 },
      envMapIntensity: { value: 1.4, min: 0, max: 3, step: 0.1 },
      // Softer, more even environment that glows rather than glares.
      preset: {
        value: "apartment",
        options: ["apartment", "city", "studio", "warehouse", "lobby", "park"],
      },
      environmentIntensity: { value: 1.0, min: 0, max: 3, step: 0.1 },
    },
    { store }
  );

  return (
    <section className="relative h-screen w-screen overflow-hidden bg-[#F5F5F6] text-[#0D2728]">
      <div className="absolute right-3 top-3 z-10 w-72">
        <LevaPanel
          store={store}
          fill
          flat
          collapsed
          titleBar={{ title: "Acrylic" }}
        />
      </div>
      <Canvas
        camera={{ position: [0, 0, 6], fov: 32 }}
        gl={{
          antialias: true,
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.0,
          outputColorSpace: SRGBColorSpace,
        }}
        dpr={[1, 2]}
      >
        {/* Solid, soft, near-white background (not transparent/empty). */}
        <color attach="background" args={["#F5F5F6"]} />

        <Suspense fallback={null}>
          {/* Auto-frame, then a default 3/4 pose (long axis up-right); drag works. */}
          <Bounds fit clip margin={1.09}>
            <DragToRotate resetDelay={1500}>
              <group rotation={[0.5, 0.7, 0]}>
                <Blocks tune={tune} />
              </group>
            </DragToRotate>
          </Bounds>

          {/* Softer, even HDRI → scene.environment that glows rather than
              glares. Transmission/reflections sample this. */}
          <Environment
            preset={tune.preset as ComponentProps<typeof Environment>["preset"]}
            environmentIntensity={tune.environmentIntensity}
          />
        </Suspense>
      </Canvas>

      <p className="pointer-events-none absolute left-6 top-6 font-mono text-xs uppercase tracking-widest opacity-50">
        Orange Acrylic · Blender script
      </p>
    </section>
  );
}

useGLTF.preload(MODEL_URL);
