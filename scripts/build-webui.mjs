/**
 * The console panel's bundle: `src/webui/client.ts` → `dist/webui.js` and `src/webui/style.css` →
 * `dist/webui.css`. The two output names are fixed by `package.json`'s `cortico.webUiClient` /
 * `cortico.webUiStyle`; the host assigns their URLs and serves both itself.
 *
 * The browser side imports the framework with `import type` only, so nothing from `cortico/*` needs
 * an alias or an external here: those imports vanish at compile time. A build that reports "Could
 * not resolve cortico/…" means a runtime import slipped in; localize it rather than allowing it.
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [
    { in: `${root}src/webui/client.ts`, out: 'webui' },
    { in: `${root}src/webui/style.css`, out: 'webui' },
  ],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: true,
  metafile: true,
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
