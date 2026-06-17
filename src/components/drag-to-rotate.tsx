"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Group } from "three";
import { useFrame, useThree } from "@react-three/fiber";

type DragToRotateProps = {
  children: ReactNode;
  /** ms of stillness after a drag before the model eases back to default. */
  resetDelay?: number;
  /** radians of rotation per pixel dragged. */
  sensitivity?: number;
  /** clamp for vertical (pitch) drag, in radians. */
  maxPitch?: number;
  /** how fast it eases home (higher = snappier). */
  returnSpeed?: number;
};

// Drag the wrapped model to rotate it (the camera, lights and environment stay
// put). `resetDelay` ms after you release, the rotation animates back to the
// default orientation. Any continuous spin on an inner group keeps running and
// composes with this — so the drag offset is what gets reset, not the spin.
export default function DragToRotate({
  children,
  resetDelay = 1500,
  sensitivity = 0.006,
  maxPitch = Math.PI / 4,
  returnSpeed = 3,
}: DragToRotateProps) {
  const groupRef = useRef<Group>(null);
  const gl = useThree((s) => s.gl);

  const drag = useRef({
    dragging: false,
    px: 0,
    py: 0,
    targetX: 0,
    targetY: 0,
    releaseAt: 0,
  });

  useEffect(() => {
    const el = gl.domElement;
    const s = drag.current;
    const onDown = (e: PointerEvent) => {
      s.dragging = true;
      s.px = e.clientX;
      s.py = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!s.dragging) return;
      s.targetY += (e.clientX - s.px) * sensitivity;
      s.targetX += (e.clientY - s.py) * sensitivity;
      s.targetX = Math.max(-maxPitch, Math.min(maxPitch, s.targetX));
      s.px = e.clientX;
      s.py = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (!s.dragging) return;
      s.dragging = false;
      s.releaseAt = performance.now();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [gl, sensitivity, maxPitch]);

  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g) return;
    const s = drag.current;

    // After `resetDelay` of no dragging, ease the drag target back to default.
    if (!s.dragging && performance.now() - s.releaseAt >= resetDelay) {
      const k = Math.min(1, delta * returnSpeed);
      s.targetX += -s.targetX * k;
      s.targetY += -s.targetY * k;
    }

    // Follow the target each frame (snappy while dragging, smooth on return).
    const f = Math.min(1, delta * 12);
    g.rotation.x += (s.targetX - g.rotation.x) * f;
    g.rotation.y += (s.targetY - g.rotation.y) * f;
  });

  return <group ref={groupRef}>{children}</group>;
}
