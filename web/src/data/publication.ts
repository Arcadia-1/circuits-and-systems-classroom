/**
 * Lessons that are ready to represent the public site.
 *
 * Every other lesson still builds and remains available by its direct URL, but
 * is deliberately omitted from the home page and search index until it reaches
 * the same editorial and visual standard.
 */
export const publicLessonPaths = [
  '/adc/aliasing-and-nyquist-zones/',
  '/adc/binary-vs-redundant-sar/',
  '/adc/pipeline-adc/',
  '/adc/analog-panel/',
  '/adc/time-interleaved-adcs/',
  '/pll/integer-vs-fractional/',
  '/amplifiers/open-loop-and-closed-loop/',
  '/serdes/112g-pam4-link/',
  '/serdes/clock-and-data-recovery/',
  '/serdes/pci-express/',
] as const;

export const publicExternalHrefs = [
  'https://many-question.github.io/bode-sketch/',
] as const;

const publicLessonPathSet = new Set<string>(publicLessonPaths);
const publicExternalHrefSet = new Set<string>(publicExternalHrefs);

export function isPublicLessonPath(pathname: string): boolean {
  return publicLessonPathSet.has(pathname);
}

export function isPublicExternalHref(href: string): boolean {
  return publicExternalHrefSet.has(href);
}

export function isLessonPath(pathname: string): boolean {
  return pathname.startsWith('/adc/') || pathname.startsWith('/pll/') || pathname.startsWith('/amplifiers/') || pathname.startsWith('/serdes/');
}
