// build.mjs — собирает code.ts в code.js для Figma plugin sandbox
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['code.ts'],
  bundle: true,
  outfile: 'code.js',
  target: 'es2017',
  platform: 'browser',
  format: 'iife',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('👀 Watching code.ts for changes…');
} else {
  await esbuild.build(config);
  console.log('✅ Built code.js');
}
