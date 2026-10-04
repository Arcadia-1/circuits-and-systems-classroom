export const THEME_KEY = 'circuits-systems-theme';

/** Lessons and their canvas renderers use one light palette. */
export function prefersLightTheme(): boolean {
  return true;
}

export function applyTheme(root: HTMLElement = document.documentElement): void {
  root.classList.remove('dark');
  root.classList.add('light');
  try { localStorage.removeItem(THEME_KEY); } catch {}
}

/** Canvas renderers use the same default as CSS, even before hydration. */
export function isLightTheme(): boolean {
  return true;
}
