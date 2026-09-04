// Minimal .env loader (no extra dependency). KEY=VALUE per line, blank lines
// and '#' comments ignored. Does not override variables already present in
// process.env (real environment wins over .env file).
// Copied pattern from genlayer-resolver/client/env.ts.

import { readFileSync, existsSync } from "fs";
import path from "path";

export function loadEnv(envPath: string = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
