import{build}from'esbuild';
await build({entryPoints:['tests/fixtures/write-executor-fault.ts'],outfile:'dist/executor-fault/main.mjs',bundle:true,platform:'node',target:'node22',format:'esm',external:['./health-ping.js']});
