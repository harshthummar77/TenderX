import type { ReactNode } from 'react';
import { ReactLenis } from 'lenis/react';

/**
 * Smooth scrolling for the main document, via the official Lenis React binding.
 *
 * Why only wrap the pages that need it, not the whole app: the authenticated
 * shell never scrolls the document — its scroll lives in a nested
 * `<main overflow-y-auto>` (AppShell), and Lenis is told to leave nested
 * containers alone. So Lenis belongs on the document-scrolling marketing pages
 * (the landing page), where `root` binds it to `window` with a single
 * instance, its own requestAnimationFrame loop, and automatic teardown that is
 * safe under React Strict Mode and Vite HMR.
 *
 * Accessibility: when the user prefers reduced motion we render children with
 * no Lenis at all, so scrolling is fully native.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced) return <>{children}</>;

  return (
    <ReactLenis
      root
      options={{
        // lerp mode: responsive and premium, not floaty. Keyboard, anchor and
        // wheel all inherit it. Nested overflow areas and anything marked
        // `data-lenis-prevent` keep native scrolling.
        lerp: 0.12,
        smoothWheel: true,
        wheelMultiplier: 1,
      }}
    >
      {children}
    </ReactLenis>
  );
}
