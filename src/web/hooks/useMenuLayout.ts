import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Which side a pop-up menu opens on and how tall it may be, measured when it opens (and on resize) so it never runs
 * off-screen. The menu is cut off by the nearest scrolling/clipping container (e.g. the welcome screen's scroll area
 * below the top bar), so the room is measured inside that, not the whole window. Used by the model menu and the
 * Tools menu in the message box.
 */
export function useMenuLayout(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  placement: "up" | "down",
  /** Height the menu would like on its preferred side before switching sides. */
  preferred = 320,
): { up: boolean; maxHeight: number } {
  const [layout, setLayout] = useState({ up: placement === "up", maxHeight: 480 });

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      let clip: DOMRect | null = null;
      for (let el = root.current?.parentElement; el; el = el.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(el).overflowY)) {
          clip = el.getBoundingClientRect();
          break;
        }
      }
      const top = Math.max(0, clip?.top ?? 0);
      const bottom = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight);
      const above = rect.top - top - 12;
      const below = bottom - rect.bottom - 12;
      // Keep the requested side when it has room; otherwise use the side with more space.
      const up = placement === "up" ? above >= preferred || above >= below : below < preferred && above > below;
      const room = up ? above : below;
      setLayout({ up, maxHeight: Math.max(160, Math.min(room, Math.round(window.innerHeight * 0.7))) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, placement, preferred, root]);

  return layout;
}
