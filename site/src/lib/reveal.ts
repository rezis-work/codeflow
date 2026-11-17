/** Fade a section in when it scrolls into view. No-ops when motion is reduced. */
export function reveal(node: HTMLElement): { destroy: () => void } | void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  node.classList.add('reveal');
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        node.classList.add('in');
        observer.disconnect();
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
  );
  observer.observe(node);
  return {
    destroy() {
      observer.disconnect();
    },
  };
}
