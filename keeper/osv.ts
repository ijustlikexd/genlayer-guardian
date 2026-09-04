// OSV.dev client used by `keeper watch` to discover new vulnerability ids for
// a target's dependencies. Mirrors the two OSV calls the Guardian contract
// itself makes in contracts/Guardian.py (_fetch_osv): GET /v1/vulns/{id} and
// POST /v1/query.
//
// keeper/lib/http-json-api.js's fetchJsonWithRetry only issues GET requests
// (see its source: `fetch(url, { headers, signal })`, no method/body option).
// So `queryOsv` (POST) is a small local retry helper instead of that shared
// lib; `getOsvVuln` (GET) reuses fetchJsonWithRetry as-is.

import { fetchJsonWithRetry } from "./lib/http-json-api.js";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";
const UA = { "User-Agent": "genlayer-guardian-keeper", Accept: "application/json" };

export interface OsvDependency {
  ecosystem: string;
  name: string;
  version: string;
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: unknown[];
  [key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST retry helper, same shape of behavior as fetchJsonWithRetry's transient
// path (short exponential backoff) plus a longer 429 backoff, kept minimal
// since OSV /v1/query is a single JSON POST with no Retry-After nuance to
// preserve beyond what we implement here directly.
async function postJsonWithRetry(
  url: string,
  body: unknown,
  opts: { retries?: number; transientBaseDelayMs?: number; rateLimitBaseDelayMs?: number } = {},
): Promise<any> {
  const { retries = 3, transientBaseDelayMs = 1000, rateLimitBaseDelayMs = 20_000 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...UA, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get("retry-after")) || 0;
        const backoffMs = Math.max(retryAfterSec * 1000, rateLimitBaseDelayMs * (attempt + 1));
        lastErr = new Error(`HTTP 429 (rate limited): ${url}`);
        if (attempt < retries) await sleep(backoffMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${url}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(transientBaseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`postJsonWithRetry failed: ${url}`);
}

// Queries OSV for known vulnerability ids affecting a single dependency.
// Queries OSV for known vulnerability ids affecting a single dependency.
// Returns canonical OSV record ids only (GHSA-* etc.). Aliases (CVE-*) are NOT expanded:
// OSV also stores CVE records with NVD-style affected data, so submitting both the GHSA
// id and its CVE alias would adjudicate the same vulnerability twice under two incident ids.
export async function queryOsv(dep: OsvDependency): Promise<string[]> {
  const body = { package: { name: dep.name, ecosystem: dep.ecosystem }, version: dep.version };
  const result = await postJsonWithRetry(OSV_QUERY_URL, body);
  const ids = new Set<string>();
  for (const v of result?.vulns ?? []) {
    if (v?.id) ids.add(String(v.id));
  }
  return [...ids].sort();
}

// Fetches full advisory detail for one vuln id. Used to skip withdrawn
// advisories before wasting an on-chain check on them.
export async function getOsvVuln(id: string): Promise<OsvVuln | null> {
  try {
    return (await fetchJsonWithRetry(`${OSV_VULN_URL}/${encodeURIComponent(id)}`, {
      headers: UA,
      retries: 3,
    })) as OsvVuln;
  } catch {
    return null;
  }
}
