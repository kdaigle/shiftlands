import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.work/tests', { recursive: true });
await build({ entryPoints: ['tests/invariants.test.ts'], outfile: '.work/tests/invariants.test.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const result = spawnSync(process.execPath, ['--test', '.work/tests/invariants.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
