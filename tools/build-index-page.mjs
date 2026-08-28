import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["src/index-page/main.ts"],
  outfile: "public/app.js",
  bundle: true,
  format: "iife",
  target: ["chrome110", "edge110", "safari15"],
  minify: false,
  legalComments: "none",
});

await copyFile("src/index-page/styles.css", "public/styles.css");
