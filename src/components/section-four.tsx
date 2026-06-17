"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { Mesh, Group } from "three";
import { Vector3, Quaternion, NeutralToneMapping } from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, ContactShadows, useGLTF } from "@react-three/drei";
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

type FallProps = {
  scale: number;
  spin: number;
  fallHeight: number;
  scatter: number;
  duration: number;
  stagger: number;
  turns: number;
};

// easeOutCubic — fast at first, gently settling at the end. Gives the blocks a
// "drop in and land" feel rather than a linear slide.
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

// Deterministic pseudo-random in [0, 1] from an integer seed — used to give each
// block a different tumble on each axis without random jitter between frames.
const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

// Hold ⌥ (Option/Alt) and scroll to zoom the camera into the model. Without the
// modifier the wheel is left alone so the page keeps scrolling normally.
function OptionZoom({ min = 0.6, max = 4 }: { min?: number; max?: number }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      const next = camera.zoom * (1 - e.deltaY * 0.0015);
      camera.zoom = Math.min(max, Math.max(min, next));
      camera.updateProjectionMatrix();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [camera, gl, min, max]);
  return null;
}

function FallingBlocks({
  glass,
  fall,
  playId,
}: {
  glass: GlassProps;
  fall: FallProps;
  playId: number;
}) {
  const { scene } = useGLTF(MODEL_URL);
  const modelRef = useRef<Group>(null);
  const groupRefs = useRef<(Group | null)[]>([]);
  const lastPlay = useRef(-1);
  const startT = useRef(0);

  // Collect every block. Their rest pose is the baked geometry (the 4 slabs
  // sitting next to each other), so the landing target is simply transform = 0.
  const blocks = useMemo(() => {
    scene.updateMatrixWorld(true);
    const out: {
      uuid: string;
      geometry: Mesh["geometry"];
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
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      out.push({
        uuid: mesh.uuid,
        geometry: mesh.geometry,
        quaternion,
        scale,
        order: bb ? (bb.min.z + bb.max.z) / 2 : 0,
      });
    });
    out.sort((a, b) => b.order - a.order);
    // Give each block a distinct tumble strength per axis so they spin on every
    // angle, not just one. Factors are >0 and ease to 0 ⇒ they always land flat.
    return out.map((b, i) => ({
      ...b,
      tumble: [
        0.6 + hash(i * 3 + 1) * 1.6,
        0.6 + hash(i * 3 + 2) * 1.6,
        0.6 + hash(i * 3 + 3) * 1.6,
      ] as [number, number, number],
    }));
  }, [scene]);

  useFrame((state, delta) => {
    // Continuous turntable spin of the whole model (default on).
    if (modelRef.current) modelRef.current.rotation.y += delta * fall.spin;

    // (Re)start the animation whenever the section scrolls back into view.
    if (playId !== lastPlay.current) {
      lastPlay.current = playId;
      startT.current = state.clock.elapsedTime;
    }
    // Until the section has been entered (playId 0) hold the blocks up in the
    // "sky" so they're ready to drop; afterwards play from the trigger time.
    const t = playId > 0 ? state.clock.elapsedTime - startT.current : 0;
    const n = blocks.length;

    for (let i = 0; i < n; i++) {
      const g = groupRefs.current[i];
      if (!g) continue;
      // Each block falls on its own slightly-delayed timeline.
      const local = Math.min(1, Math.max(0, (t - i * fall.stagger) / fall.duration));
      const e = easeOut(local);
      const inv = 1 - e; // 1 at the start (in the sky), 0 once landed

      // Spread the blocks apart in BOTH width and depth at the start so the
      // tumbling slabs stay clear of each other, then converge into the stacked
      // block as they land.
      const spread = i - (n - 1) / 2;
      g.position.x = inv * spread * fall.scatter;
      g.position.z = inv * spread * fall.scatter * 0.7;
      g.position.y = inv * fall.fallHeight;

      // Tumble on all three axes while falling, unwinding to a flat, aligned
      // rest pose. Each axis uses its own factor so it spins on every angle.
      const ang = inv * fall.turns * Math.PI * 2;
      const [tx, ty, tz] = blocks[i].tumble;
      g.rotation.x = ang * tx;
      g.rotation.y = ang * ty;
      g.rotation.z = ang * tz;
    }
  });

  return (
    <group ref={modelRef} scale={fall.scale}>
      {blocks.map((block, i) => (
        <group
          key={block.uuid}
          ref={(el) => {
            groupRefs.current[i] = el;
          }}
          position-y={fall.fallHeight}
        >
          <mesh geometry={block.geometry} quaternion={block.quaternion} scale={block.scale}>
            {/* Orange translucent glass: alpha-blended so overlapping slabs
                deepen toward red (the signature of the reference). Clearcoat
                adds the glossy surface sheen. */}
            <meshPhysicalMaterial transparent {...glass} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

useGLTF.preload(MODEL_URL);

export default function SectionFour() {
  // Own Leva store so this scene's panel doesn't collide with other sections'.
  const store = useCreateStore();

  // Scroll trigger: bump `playId` every time the section enters the viewport so
  // the drop-in animation (re)plays.
  const sectionRef = useRef<HTMLElement>(null);
  const [playId, setPlayId] = useState(0);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setPlayId((id) => id + 1);
      },
      { threshold: 0.35 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const glass = useControls(
    "Glass",
    {
      // Orange translucent glass — lower opacity ⇒ overlaps build toward a
      // deeper red, matching the reference. Glossy via clearcoat.
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

  // Drop-in animation. `scale` sizes the whole model on screen; `spin` is the
  // continuous turntable rotation; `fallHeight` is how far up they start;
  // `scatter` spreads them apart (width + depth) so the
  // tumbling slabs don't touch; `duration` is each block's fall time; `stagger`
  // delays each successive block; `turns` is how many times each tumbles on the
  // way down before settling flat.
  const fall = useControls(
    "Fall",
    {
      scale: { value: 0.65, min: 0.2, max: 1.5, step: 0.05 },
      spin: { value: 0.3, min: 0, max: 2, step: 0.05 },
      fallHeight: { value: 7, min: 0, max: 15, step: 0.1 },
      scatter: { value: 3, min: 0, max: 6, step: 0.05 },
      duration: { value: 1.6, min: 0.2, max: 5, step: 0.1 },
      stagger: { value: 0.3, min: 0, max: 1, step: 0.01 },
      turns: { value: 1, min: 0, max: 4, step: 0.1 },
    },
    { store }
  );

  const { lightColor, lightIntensity } = useControls(
    "Lighting",
    {
      // Neutral, bright key light — the orange now comes from the material, so
      // keep the light white to keep the colour true (like the reference).
      lightColor: "#ffffff",
      lightIntensity: { value: 2, min: 0, max: 10, step: 0.1 },
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
      environmentIntensity: { value: 1.0, min: 0, max: 4, step: 0.1 },
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
        <LevaPanel store={store} fill flat titleBar={{ title: "Fall" }} />
      </div>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        gl={{ antialias: true, toneMapping: NeutralToneMapping }}
        dpr={[1, 2]}
      >
        <color attach="background" args={[background]} />

        <OptionZoom />

        <directionalLight
          position={[3, 5, 4]}
          intensity={lightIntensity}
          color={lightColor}
        />

        <Suspense fallback={null}>
          {/* Drag rotates the MODEL (camera/lighting stay put); 1.5s after you
              let go it eases back to the default orientation. */}
          <DragToRotate resetDelay={1500}>
            <FallingBlocks glass={glass} fall={fall} playId={playId} />
          </DragToRotate>
          <Environment
            preset={preset as ComponentProps<typeof Environment>["preset"]}
            environmentIntensity={environmentIntensity}
          />
          {/* Ground shadow that forms as the blocks descend into range — sells
              the landing. */}
          <ContactShadows
            position={[0, -0.4, 0]}
            opacity={0.3}
            scale={5}
            blur={3}
            far={2.5}
          />
        </Suspense>
      </Canvas>

      <p className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-sm opacity-50">
        Orange glass · drag to rotate · hold ⌥ and scroll to zoom →
      </p>
    </section>
  );
}
