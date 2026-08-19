import { useEffect, useRef, useCallback } from "react";

/**
 * Captures WASD/Arrow key input and returns a direction vector.
 * Returns { dx, dy } in range [-1, 1] where diagonal movement is normalized.
 * The caller applies this to move the robot via the `moveRobotManual` mutation.
 */
export function useKeyboardControl() {
  const keysRef = useRef(new Set<string>());
  const enabledRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      const key = e.key.toLowerCase();
      if (
        ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)
      ) {
        e.preventDefault();
        keysRef.current.add(key);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keysRef.current.delete(key);
    };

    const handleBlur = () => keysRef.current.clear();

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const getDirection = useCallback(() => {
    const keys = keysRef.current;
    let dx = 0;
    let dy = 0;
    if (keys.has("w") || keys.has("arrowup")) dy = -1;
    if (keys.has("s") || keys.has("arrowdown")) dy = 1;
    if (keys.has("a") || keys.has("arrowleft")) dx = -1;
    if (keys.has("d") || keys.has("arrowright")) dx = 1;
    // Normalize diagonal
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    return { dx, dy };
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    enabledRef.current = enabled;
    if (!enabled) keysRef.current.clear();
  }, []);

  const isMoving = useCallback(() => keysRef.current.size > 0, []);

  return { getDirection, setEnabled, isMoving };
}
