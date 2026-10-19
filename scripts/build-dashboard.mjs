import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/dashboard-public", { recursive: true });
await build({ entryPoints: ["dashboard/app.tsx"], bundle: true, minify: true, outfile: "dist/dashboard-public/app.js", platform: "browser", jsx: "automatic" });
await copyFile("dashboard/index.html", "dist/dashboard-public/index.html");
