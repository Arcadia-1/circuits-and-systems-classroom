export const THEME_KEY = 'circuits-systems-theme';

/** Start in light mode unless the reader explicitly selected dark mode. */
export function prefersLightTheme(): boolean {
  try { return localStorage.getItem(THEME_KEY) !== 'dark'; }
  catch { return true; }
}

export function applyTheme(root: HTMLElement = document.documentElement): void {
  const light = prefersLightTheme();
  root.classList.toggle('light', light);
  root.classList.toggle('dark', !light);
}

/** Canvas renderers use the same default as CSS, even before hydration. */
export function isLightTheme(): boolean {
  return !document.documentElement.classList.contains('dark');
}
