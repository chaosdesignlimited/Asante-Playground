"use client";

import { Suspense, useMemo } from "react";
import type { Mesh, MeshPhysicalMaterial } from "three";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Bounds,
  Environment,
  ContactShadows,
  useGLTF,
} from "@react-three/drei";

const MODEL_URL = "/model/orange_glass_block.glb";

function OrangeGlassBlock() {
  const { scene } = useGLTF(MODEL_URL);

  // The .glb has transmission + ior but no KHR_materials_volume extension, so
  // it imports with thickness 0 and no absorption — i.e. thin, flat glass.
  // Add volume + orange attenuation here to give the block real depth.
  useMemo(() => {
    scene.traverse((obj) => {
      const mat = (obj as Mesh).material as MeshPhysicalMaterial | undefined;
      if (!mat || !("transmission" in mat)) return;
      mat.thickness = 1.5; // how much volume absorption shows through
      mat.attenuationDistance = 2.0; // longer keeps it orange; too short crushes green/blue → red
      mat.attenuationColor.setRGB(1.0, 0.45, 0.06); // orange tint of absorbed light
      mat.roughness = 0;
      mat.ior = 1.55;
      mat.needsUpdate = true;
    });
  }, [scene]);

  // Bounds auto-frames + centers the model. margin > 1 shrinks it; ~2 leaves
  // the block taking up roughly half the viewport width. `observe` re-fits on
  // resize so it stays ~50% across viewport sizes.
  return (
    <Bounds fit clip observe margin={2}>
      <primitive object={scene} />
    </Bounds>
  );
}

// Preload so the model is ready as soon as the section mounts.
useGLTF.preload(MODEL_URL);

export default function SectionTwo() {
  return (
    <section className="relative h-screen w-screen bg-[#0D2728] text-white">
      <Canvas
        camera={{ position: [0, 0, 4], fov: 45 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 5, 5]} intensity={1.2} />
        <directionalLight position={[-5, -2, -5]} intensity={0.4} />

        <Suspense fallback={null}>
          <OrangeGlassBlock />
          {/* Environment gives the glass something to reflect/refract. */}
          <Environment preset="city" />
          <ContactShadows
            position={[0, -1.2, 0]}
            opacity={0.4}
            scale={8}
            blur={2.5}
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
