import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/isolated-executor', { recursive: true });
await build({ entryPoints: ['src/executor-runtime/main.ts'], outfile: 'dist/isolated-executor/main.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['./health-ping.js','./write-demo-receipt.js'] });
await build({ entryPoints: ['src/executor-runtime/initialize.ts'], outfile: 'dist/isolated-executor/initialize.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm' });
await copyFile('dist/src/executor-runtime/health-ping.js', 'dist/isolated-executor/health-ping.js');

await build({ entryPoints: ["src/executor-runtime/evidence-main.ts"], outfile: "dist/isolated-executor/evidence.mjs", bundle: true, platform: "node", target: "node22", format: "esm" });

await build({entryPoints:["src/executor-runtime/write-demo-receipt.ts"],outfile:"dist/isolated-executor/write-demo-receipt.js",bundle:true,platform:"node",target:"node22",format:"esm"});
