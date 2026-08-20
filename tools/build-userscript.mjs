import { build } from "esbuild";

const metadata = `// ==UserScript==
// @name         ASMRGay Browser Enhancer
// @namespace    local.asmrgay.browser-enhancer
// @version      0.1.0
// @description  为 ASMRGay 增加当前目录索引、搜索、筛选和收藏
// @match        https://www.asmrgay.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==`;

await build({
  entryPoints: ["src/userscript/main.ts"],
  outfile: "dist/asmrgay-browser-enhancer.user.js",
  bundle: true,
  format: "iife",
  target: ["chrome110", "edge110"],
  minify: false,
  legalComments: "none",
  banner: { js: metadata },
});
