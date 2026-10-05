// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';
import { publicLessonPaths } from './src/data/publication.ts';
import { execFileSync } from 'node:child_process';

// Embedded in diagnostic exports so a replay can be matched to its source build.
/** @param {string[]} args */
const git = (args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch { return null; }
};
const workingTree = git(['status', '--porcelain']);
const buildInfo = {
  revision: process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']) || 'unknown',
  builtAt: new Date().toISOString(),
  dirty: workingTree === null ? null : workingTree.length > 0,
};

const publicPages = new Set(['/', ...publicLessonPaths]);

// Every page is prerendered; the interactive parts are Svelte islands and the copied analytics module (analytics/) is
// React. ADC lessons link to the separately maintained ADCToolbox reference manual, which is built into dist/doc by
// the deploy workflow from the Sphinx source in the ADCToolbox repository.
export default defineConfig({
  site: 'https://circuits-and-systems.tokenzhang.com',
  output: 'static',
  trailingSlash: 'always',
  integrations: [svelte(), react(), sitemap({ filter: (page) => publicPages.has(new URL(page).pathname) })],
  vite: { define: { __CLASSROOM_BUILD__: JSON.stringify(buildInfo) } },
  build: { format: 'directory', inlineStylesheets: 'auto' },
});
