#!/usr/bin/env node
/**
 * Local development: applies local D1 migrations, then runs the API (wrangler dev, :8787)
 * and the web app with hot reload (vite, :5173) together. Open http://localhost:5173.
 */
import { spawn, spawnSync } from "node:child_process";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const opts = { stdio: "inherit", shell: process.platform === "win32" };

const migrate = spawnSync(npx, ["wrangler", "d1", "migrations", "apply", "DB", "--local"], opts);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const children = [
  spawn(npx, ["wrangler", "dev", "--port", "8787", "--local"], opts),
  spawn(npx, ["vite"], opts),
];
const stop = () => children.forEach((c) => c.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((c) => c.on("exit", (code) => {
  stop();
  process.exit(code ?? 0);
}));
