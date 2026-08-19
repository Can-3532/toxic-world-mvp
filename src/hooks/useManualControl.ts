import { useEffect, useRef, useCallback } from "react";
import { MANUAL, WORLD } from "@/convex/gameParams";export type MovementInput = {
  dx: number;
  dy: number;
};

export type CollectSignal = boolean;

/**
 * Hook that captures WASD / Arrow key input and returns the current
 * movement vector (dx, dy) normalized to [-1, 1]. The caller applies
 * this to the robot position in a requestAnimationFrame loop.
 * Also exposes a consumeCollect() that returns true once when E is pressed.
 */
export function useManualControl(enabled: boolean) {
  const keysRef = useRef<Set<string>>(new Set());
  const collectRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      keysRef.current.clear();
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const key = e.key.toLowerCase();
      if (
        ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)
      ) {
        e.preventDefault();
        keysRef.current.add(key);
      }
      // E key = collect action
      if (key === "e") {
        e.preventDefault();
        collectRef.current = true;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keysRef.current.delete(key);
    };

    // Clear all keys when window loses focus
    const handleBlur = () => {
      keysRef.current.clear();
      collectRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [enabled]);

  /** Compute normalized movement vector from current key state. */
  const getMovement = useCallback((): MovementInput => {
    const keys = keysRef.current;
    let dx = 0;
    let dy = 0;

    if (keys.has("w") || keys.has("arrowup")) dy = -1;
    if (keys.has("s") || keys.has("arrowdown")) dy = 1;
    if (keys.has("a") || keys.has("arrowleft")) dx = -1;
    if (keys.has("d") || keys.has("arrowright")) dx = 1;

    // Normalize diagonal movement
    if (dx !== 0 && dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len;
      dy /= len;
    }

    return { dx, dy };
  }, []);

  /** Consume the E-key collect signal (returns true once per press). */
  const consumeCollect = useCallback((): boolean => {
    if (collectRef.current) {
      collectRef.current = false;
      return true;
    }
    return false;
  }, []);

  return { getMovement, consumeCollect };
}

/**
 * Clamp a position to the map bounds.
 */
export function clampToMap(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(WORLD.MAP_SIZE, x)),
    y: Math.max(0, Math.min(WORLD.MAP_SIZE, y)),
  };
}
