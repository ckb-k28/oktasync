import fs from 'fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

function resolveBuildVersion(command: 'build' | 'serve'): string {
  const envVersion = process.env.VITE_APP_VERSION?.trim();
  if (envVersion) {
    return envVersion;
  }

  const versionFile = path.resolve(__dirname, 'VERSION');
  let currentNum = 1;
  let currentLabel = 'v.01';

  if (fs.existsSync(versionFile)) {
    const raw = fs.readFileSync(versionFile, 'utf-8').trim();
    const match = raw.match(/^v\.0*(\d+)$/i);
    if (match) {
      currentNum = Math.max(1, parseInt(match[1], 10));
      currentLabel = `v.${String(currentNum).padStart(2, '0')}`;
    } else if (raw) {
      currentLabel = raw;
    }
  }

  if (command === 'build') {
    const nextNum = fs.existsSync(versionFile) ? currentNum + 1 : 1;
    const nextLabel = `v.${String(nextNum).padStart(2, '0')}`;
    fs.writeFileSync(versionFile, `${nextLabel}\n`, 'utf-8');
    return nextLabel;
  }

  return currentLabel;
}

export default defineConfig(({command}) => {
  const appVersion = resolveBuildVersion(command);
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
