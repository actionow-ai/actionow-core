/**
 * Make the rest of the app inert while a modal surface (Modal/Drawer) is open.
 * The surface is portaled to <body> (a sibling of #root), so marking #root
 * `inert` + `aria-hidden` removes the background from the tab order AND the a11y
 * tree — the focus trap only corrals Tab, so this is what actually stops a
 * screen-reader virtual cursor (and mouse) from reaching background content
 * behind `aria-modal`. Ref-counted so a stacked overlay doesn't release early.
 */
let locks = 0;

export function lockBackground(rootId = 'root'): () => void {
  const root = document.getElementById(rootId);
  locks += 1;
  if (root !== null) {
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
  }
  return () => {
    locks = Math.max(0, locks - 1);
    if (locks === 0 && root !== null) {
      root.removeAttribute('inert');
      root.removeAttribute('aria-hidden');
    }
  };
}
