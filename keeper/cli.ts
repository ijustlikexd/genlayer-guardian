// Guardian keeper CLI.
//
// The keeper is a dumb trigger, not a decision-maker. It never evaluates an
// advisory, never picks an action, and never judges prerequisites: it only
// calls the Guardian contract's `check` write (and a few read-only views).
// All adjudication (applicability, severity, prerequisites, action) happens
// inside the contract's own non-deterministic block, independently per
// validator. If you are looking for policy logic, it is not here: see
// contracts/Guardian.py.

import { loadEnv } from "./env.js";
import { createGuardianClient, type NetworkName, type Source } from "./client.js";
import { queryOsv, getOsvVuln } from "./osv.js";
import { throttleByHost } from "./lib/http-host-throttle.js";
import { readFileSync } from "fs";

loadEnv();

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v;
}

function getClient() {
  const privateKey = requireEnv("ACCOUNT_PRIVATE_KEY") as `0x${string}`;
  const network = (process.env.GENLAYER_NETWORK || "studionet") as NetworkName;
  const guardianAddress = requireEnv("GUARDIAN_ADDRESS") as `0x${string}`;
  return createGuardianClient({ network, privateKey, guardianAddress });
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

// ---------------------------------------------------------------- commands

async function cmdCheck(args: string[]): Promise<void> {
  const [targetId, source, incidentId] = args;
  if (!targetId || !source || !incidentId) {
    throw new Error("usage: check <target_id> <source> <incident_id> [--wait-final]");
  }
  if (source !== "osv" && source !== "github_repo_advisory") {
    throw new Error('source must be "osv" or "github_repo_advisory"');
  }
  const waitFinal = hasFlag(args, "--wait-final");

  const client = getClient();
  const result = await client.check(targetId, source as Source, incidentId);
  log("check_submitted", {
    target_id: targetId,
    source,
    incident_id: incidentId,
    submit_time: result.submitTime,
    accepted_time: result.acceptedTime,
    tx_hash: result.txHash,
    verdict_key: result.verdictKey,
  });

  const verdict = await client.getVerdict(result.verdictKey);
  console.log(JSON.stringify(verdict, null, 2));

  if (waitFinal) {
    const { finalizedTime } = await client.waitFinalized(result.txHash);
    log("check_finalized", { target_id: targetId, verdict_key: result.verdictKey, finalized_time: finalizedTime });
    const finalVerdict = await client.getVerdict(result.verdictKey);
    console.log(JSON.stringify(finalVerdict, null, 2));
  }
}

async function cmdVerdict(args: string[]): Promise<void> {
  const [key] = args;
  if (!key) throw new Error("usage: verdict <key>");
  const client = getClient();
  const verdict = await client.getVerdict(key);
  console.log(JSON.stringify(verdict, null, 2));
}

async function cmdVault(args: string[]): Promise<void> {
  const [address] = args;
  if (!address) throw new Error("usage: vault <address>");
  const client = getClient();
  const state = await client.readVaultState(address as `0x${string}`);
  console.log(JSON.stringify(state, null, 2));
}

async function cmdRegister(args: string[]): Promise<void> {
  const [targetId, vaultAddress, manifestPath, policyPath, sourceRepo] = args;
  if (!targetId || !vaultAddress || !manifestPath || !policyPath) {
    throw new Error("usage: register <target_id> <vault_address> <manifest.json path> <policy.json path> [source_repo]");
  }
  const manifestJson = readFileSync(manifestPath, "utf-8");
  const policyJson = readFileSync(policyPath, "utf-8");
  const client = getClient();
  const { txHash } = await client.registerTarget(
    targetId,
    vaultAddress as `0x${string}`,
    manifestJson,
    policyJson,
    sourceRepo || "",
  );
  log("target_registered", { target_id: targetId, vault_address: vaultAddress, tx_hash: txHash });
}

async function cmdUpdateManifest(args: string[]): Promise<void> {
  const [targetId, manifestPath] = args;
  if (!targetId || !manifestPath) throw new Error("usage: update-manifest <target_id> <manifest.json path>");
  const manifestJson = readFileSync(manifestPath, "utf-8").trim();
  JSON.parse(manifestJson); // fail early on invalid JSON
  const client = getClient();
  const { txHash } = await client.updateManifest(targetId, manifestJson);
  log("manifest_updated", { target_id: targetId, tx_hash: txHash });
}

async function cmdUpdatePolicy(args: string[]): Promise<void> {
  const [targetId, policyPath] = args;
  if (!targetId || !policyPath) throw new Error("usage: update-policy <target_id> <policy.json path>");
  const policyJson = readFileSync(policyPath, "utf-8").trim();
  JSON.parse(policyJson);
  const client = getClient();
  const { txHash } = await client.updatePolicy(targetId, policyJson);
  log("policy_updated", { target_id: targetId, tx_hash: txHash });
}

async function cmdResume(args: string[]): Promise<void> {
  const [targetId, verdictKey] = args;
  if (!targetId || !verdictKey) throw new Error("usage: resume <target_id> <verdict_key>");
  const client = getClient();
  const { reasonCode, txHash } = await client.requestResume(targetId, verdictKey);
  log("resume_requested", { target_id: targetId, verdict_key: verdictKey, reason_code: reasonCode, tx_hash: txHash });
}

async function cmdWatch(args: string[]): Promise<void> {
  const [targetId] = args;
  if (!targetId) throw new Error("usage: watch <target_id> [--interval 300]");
  const intervalSec = Number(parseFlag(args, "--interval") ?? "300");
  const client = getClient();

  const seen = new Set<string>();
  let stopped = false;
  let running = false;

  async function hasOnChainVerdict(source: Source, incidentId: string): Promise<boolean> {
    // "No verdict yet" covers both an unknown key (fresh incident) and any
    // revert while reading it; the keeper is not in the business of
    // distinguishing those, it just decides whether to submit a check.
    let key: string;
    try {
      key = await client.verdictKeyFor(targetId, source, incidentId);
    } catch {
      return false;
    }
    const verdict = await client.tryGetVerdict(key);
    return verdict !== null;
  }

  async function poll(): Promise<void> {
    if (running) return; // skip overlapping ticks if a previous poll is still in flight
    running = true;
    try {
      const target = await client.getTarget(targetId);
      log("poll_start", { target_id: targetId, dependencies: target.manifest.dependencies.length });

      for (const dep of target.manifest.dependencies) {
        let ids: string[];
        try {
          ids = await throttleByHost("https://api.osv.dev/v1/query", () => queryOsv(dep));
        } catch (e) {
          log("osv_query_failed", { target_id: targetId, dependency: `${dep.ecosystem}:${dep.name}`, error: String(e) });
          continue;
        }

        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);

          const alreadyAdjudicated = await hasOnChainVerdict("osv", id);
          if (alreadyAdjudicated) {
            log("skip_already_adjudicated", { target_id: targetId, incident_id: id });
            continue;
          }

          // Skip withdrawn advisories before spending an on-chain check; the
          // contract would reach the same INSUFFICIENT_EVIDENCE conclusion,
          // this just avoids the transaction.
          const vuln = await throttleByHost("https://api.osv.dev/v1/vulns", () => getOsvVuln(id));
          if (vuln?.withdrawn) {
            log("skip_withdrawn", { target_id: targetId, incident_id: id });
            continue;
          }

          try {
            const result = await client.check(targetId, "osv", id);
            log("check_submitted", {
              target_id: targetId,
              source: "osv",
              incident_id: id,
              submit_time: result.submitTime,
              accepted_time: result.acceptedTime,
              tx_hash: result.txHash,
              verdict_key: result.verdictKey,
            });
          } catch (e) {
            log("check_failed", { target_id: targetId, incident_id: id, error: String(e) });
          }
        }
      }
      log("poll_end", { target_id: targetId, seen_total: seen.size });
    } catch (e) {
      log("poll_error", { target_id: targetId, error: String(e) });
    } finally {
      running = false;
    }
  }

  log("watch_started", { target_id: targetId, interval_sec: intervalSec });
  await poll();
  const timer = setInterval(() => {
    if (!stopped) void poll();
  }, intervalSec * 1000);

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    log("watch_stopped", { target_id: targetId });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "check":
      return cmdCheck(args);
    case "watch":
      return cmdWatch(args);
    case "verdict":
      return cmdVerdict(args);
    case "vault":
      return cmdVault(args);
    case "register":
      return cmdRegister(args);
    case "resume":
      return cmdResume(args);
    case "update-manifest":
      return cmdUpdateManifest(args);
    case "update-policy":
      return cmdUpdatePolicy(args);
    default:
      console.error(
        [
          "usage: keeper <command> [args]",
          "  update-manifest <target_id> <manifest.json>   update-policy <target_id> <policy.json>",
          "",
          "  check <target_id> <source> <incident_id> [--wait-final]",
          "  watch <target_id> [--interval 300]",
          "  verdict <key>",
          "  vault <address>",
          "  register <target_id> <vault_address> <manifest.json path> <policy.json path> [source_repo]",
          "  resume <target_id> <verdict_key>",
        ].join("\n"),
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
