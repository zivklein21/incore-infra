// Bundles each src/functions/*.ts entry point into its own self-contained
// dist/<name>.js via esbuild, instead of tsc's old 1:1 src->dist compile.
//
// Why: lambdas.tf used to zip the whole (tsc-compiled) dist/ directory once
// and share that single zip's hash across every aws_lambda_function
// resource — so touching one function's source invalidated every
// function's source_code_hash and forced Terraform to redeploy all ~137
// Lambdas. Bundling per-function (each pulling in only the src/lib code it
// actually imports) lets lambdas.tf zip/hash each function independently,
// so an unrelated function's hash — and Terraform's plan — is untouched by
// a one-function change.
//
// No behavior change: this is a mechanical bundle (inline the local import
// graph) with minification off, so the emitted code is a straightforward
// concatenation of the same source, not a rewrite. Real npm dependencies
// stay external (unbundled) — they're still loaded from the shared
// dependencies Lambda Layer (see stage_layer/dependencies_layer in
// lambdas.tf), same as before. sharp especially cannot be bundled: it ships
// a platform-native binary that must be required as an ordinary package,
// not inlined.
import { build } from 'esbuild';
import { readFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const functionsDir = path.join(rootDir, 'src', 'functions');
const outDir = path.join(rootDir, 'dist');

const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

const entryPoints = readdirSync(functionsDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(functionsDir, f));

rmSync(outDir, { recursive: true, force: true });

await build({
  entryPoints,
  outdir: outDir,
  outbase: functionsDir,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log(`[build] bundled ${entryPoints.length} functions -> ${path.relative(rootDir, outDir)}/`);
