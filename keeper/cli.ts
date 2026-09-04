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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";

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

// For commands that do not need a Guardian contract address (deploy, set-guardian).
function getClientNoAddress() {
  const privateKey = requireEnv("ACCOUNT_PRIVATE_KEY") as `0x${string}`;
  const network = (process.env.GENLAYER_NETWORK || "studionet") as NetworkName;
  return createGuardianClient({ network, privateKey });
}

// CLI args after the required positionals are passed through as constructor args.
// JSON-decode each one so numbers/booleans/objects survive; fall back to the raw string.
function parseArg(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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


// Pending-finalization tracker. Every check/resume tx this keeper submits is recorded here;
// `finalize-pending` tries each and drops the ones that finalize. Local state only.
const PENDING_PATH = "keeper/pending-finalize.json";
function loadPending(): { txId: string; kind: string; submitted: string }[] {
  try { return JSON.parse(readFileSync(PENDING_PATH, "utf-8")); } catch { return []; }
}
function savePending(list: { txId: string; kind: string; submitted: string }[]): void {
  writeFileSync(PENDING_PATH, JSON.stringify(list, null, 2) + "\n");
}
function trackPending(txId: string, kind: string): void {
  const list = loadPending();
  if (!list.some((p) => p.txId === txId)) list.push({ txId, kind, submitted: new Date().toISOString() });
  savePending(list);
}

async function cmdFinalize(args: string[]): Promise<void> {
  if (!args.length) throw new Error("usage: finalize <txId> [<txId> ...]");
  const client = getClient();
  for (const txId of args) {
    const r = await client.finalize(txId);
    log(r.ok ? "finalized" : "finalize_not_ready", { tx_id: txId, evm_tx: r.evmTx, error: r.error });
  }
}

// One pass over the tracker: try every pending tx, drop the ones that finalize. Returns how many remain.
async function finalizePendingRound(): Promise<number> {
  const client = getClient();
  const list = loadPending();
  const remaining: typeof list = [];
  for (const p of list) {
    const r = await client.finalize(p.txId);
    if (r.ok) log("finalized", { tx_id: p.txId, kind: p.kind, evm_tx: r.evmTx });
    else { remaining.push(p); log("finalize_not_ready", { tx_id: p.txId, kind: p.kind, error: r.error }); }
  }
  savePending(remaining);
  log("finalize_pending_done", { finalized: list.length - remaining.length, remaining: remaining.length });
  return remaining.length;
}

const FINALIZE_UNTIL_EMPTY_MAX_ROUNDS = 24;

async function cmdFinalizePending(args: string[]): Promise<void> {
  if (!hasFlag(args, "--until-empty")) {
    await finalizePendingRound();
    return;
  }

  const intervalSec = Number(parseFlag(args, "--interval") ?? "300");
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    log("finalize_pending_stopped", {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (let round = 0; round < FINALIZE_UNTIL_EMPTY_MAX_ROUNDS && !stopped; round++) {
    const remaining = await finalizePendingRound();
    if (remaining === 0 || stopped) break;
    if (round < FINALIZE_UNTIL_EMPTY_MAX_ROUNDS - 1) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }
}

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
  trackPending(String(result.txHash), "check");
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

async function cmdDeploy(args: string[]): Promise<void> {
  const [codePath, ...ctorArgsRaw] = args;
  if (!codePath) throw new Error("usage: deploy <contracts/File.py> [args...]");
  const ctorArgs = ctorArgsRaw.map(parseArg);
  const client = getClientNoAddress();
  const { address, txHash } = await client.deployContract(codePath, ctorArgs);
  console.log(JSON.stringify({ address, tx_hash: txHash }));
}

async function cmdSetGuardian(args: string[]): Promise<void> {
  const [vaultAddress, guardianAddress] = args;
  if (!vaultAddress || !guardianAddress) {
    throw new Error("usage: set-guardian <vault_address> <guardian_address>");
  }
  const client = getClientNoAddress();
  const { txHash } = await client.setGuardian(vaultAddress as `0x${string}`, guardianAddress as `0x${string}`);
  log("guardian_set", { vault_address: vaultAddress, guardian_address: guardianAddress, tx_hash: txHash });
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

async function cmdResumeAll(args: string[]): Promise<void> {
  const [targetId] = args;
  if (!targetId) throw new Error("usage: resume-all <target_id>");
  const client = getClient();
  const { txHash, open } = await client.requestResumeAll(targetId);
  trackPending(String(txHash), "resume-all");
  log("resume_all_requested", { target_id: targetId, tx_hash: txHash, still_open: open });
}

async function cmdResume(args: string[]): Promise<void> {
  const [targetId, verdictKey] = args;
  if (!targetId || !verdictKey) throw new Error("usage: resume <target_id> <verdict_key>");
  const client = getClient();
  const { reasonCode, txHash } = await client.requestResume(targetId, verdictKey);
  trackPending(String(txHash), "resume");
  log("resume_requested", { target_id: targetId, verdict_key: verdictKey, reason_code: reasonCode, tx_hash: txHash });
}

// ------------------------------------------------------------ deploy-all

interface DeploySpecTarget {
  target_id: string;
  manifest: string | Record<string, unknown>;
  policy: string | Record<string, unknown>;
  source_repo: string;
}

interface DeploySpec {
  targets: DeploySpecTarget[];
}

// A manifest/policy field is either an inline JSON object or a path to a JSON file.
function resolveJsonField(value: string | Record<string, unknown>): string {
  if (typeof value === "string") return readFileSync(value, "utf-8").trim();
  return JSON.stringify(value);
}

// Run the genlayer CLI (npx genlayer ...) and return its stdout. Used only by the
// --signer cli path of deploy-all, so the CLI's own active account signs instead of
// the .env keeper key. `shell: true` because `npx` is a .cmd shim on Windows.
function runGenlayerCli(cliArgs: string[]): string {
  return execFileSync("npx", ["genlayer", ...cliArgs], { encoding: "utf-8", shell: true });
}

// UNVERIFIED: exact wording of `npx genlayer deploy` output was not observed live; this
// matches a "Contract Address: 0x..." style line case-insensitively.
function parseContractAddressFromCli(output: string): string {
  const m = output.match(/contract address['"]?\s*:\s*['"]?(0x[0-9a-fA-F]{40})/i);
  if (!m) throw new Error(`Could not parse contract address from CLI output:\n${output}`);
  return m[1];
}

function cliDeploy(contractPath: string): string {
  const output = runGenlayerCli(["deploy", "--contract", contractPath]);
  return parseContractAddressFromCli(output);
}

function cliSetGuardian(vaultAddress: string, guardianAddress: string): void {
  runGenlayerCli(["write", vaultAddress, "set_guardian", "--args", guardianAddress]);
}

const DEPLOYMENTS_PATH = "deployments.json";

interface DeploymentCurrentEntry {
  guardian: string;
  vaults: Record<string, string>;
  deployedAt: string;
  signer: "env" | "cli";
}

interface DeploymentsFile {
  current: Record<string, DeploymentCurrentEntry>;
  history: unknown[];
}

// Migrates the old flat-array deployments.json into { current, history } on first run,
// preserving every previous entry verbatim in history.
function updateDeploymentsFile(network: string, signer: "env" | "cli", guardian: string, vaults: Record<string, string>): void {
  let raw: unknown = null;
  try { raw = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf-8")); } catch { raw = null; }

  let file: DeploymentsFile;
  if (Array.isArray(raw)) {
    file = { current: {}, history: raw };
  } else if (raw && typeof raw === "object" && "current" in (raw as Record<string, unknown>)) {
    file = raw as DeploymentsFile;
  } else {
    file = { current: {}, history: [] };
  }

  file.current[network] = { guardian, vaults, deployedAt: new Date().toISOString(), signer };
  writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(file, null, 2) + "\n");
}

const SITE_CONFIG_PATH = "site/public/config.json";

// Updates only the deployed network's guardian/targets values in site/public/config.json.
// Leaves every other key (default_network, other networks, repo_url) untouched.
function updateSiteConfig(network: string, guardian: string, vaults: Record<string, string>): void {
  let config: any;
  try {
    config = JSON.parse(readFileSync(SITE_CONFIG_PATH, "utf-8"));
  } catch {
    log("site_config_missing", { path: SITE_CONFIG_PATH });
    return;
  }
  config.networks = config.networks || {};
  const entry = config.networks[network] || {};
  entry.guardian = guardian;
  entry.targets = Object.entries(vaults).map(([id, vault]) => ({ id, vault }));
  if (!entry.chain) entry.chain = network === "testnet-bradbury" ? "testnetBradbury" : network;
  config.networks[network] = entry;
  writeFileSync(SITE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// Writes GUARDIAN_ADDRESS into .env only if this deploy's network matches the network
// the .env file itself is already configured for. Never creates .env from scratch.
function maybeWriteEnvGuardianAddress(network: string, guardianAddress: string): void {
  if (process.env.GENLAYER_NETWORK !== network) return;
  const envPath = ".env";
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (/^GUARDIAN_ADDRESS=/.test(line)) { found = true; return `GUARDIAN_ADDRESS=${guardianAddress}`; }
    return line;
  });
  if (!found) updated.push(`GUARDIAN_ADDRESS=${guardianAddress}`);
  writeFileSync(envPath, updated.join("\n"));
  log("env_guardian_address_updated", { network, guardian_address: guardianAddress });
}

async function cmdDeployAll(args: string[]): Promise<void> {
  const [network] = args;
  if (!network) {
    throw new Error("usage: deploy-all <network> [--signer env|cli] [--spec docs/examples/deploy-spec.json]");
  }
  const signer = (parseFlag(args, "--signer") ?? "env") as "env" | "cli";
  if (signer !== "env" && signer !== "cli") throw new Error('--signer must be "env" or "cli"');
  const specPath = parseFlag(args, "--spec") ?? "docs/examples/deploy-spec.json";

  const spec = JSON.parse(readFileSync(specPath, "utf-8")) as DeploySpec;
  if (!spec.targets || !spec.targets.length) throw new Error(`No targets in spec ${specPath}`);

  const netName = network as NetworkName;
  const vaults: Record<string, string> = {};
  let guardianAddress: string;

  if (signer === "env") {
    const privateKey = requireEnv("ACCOUNT_PRIVATE_KEY") as `0x${string}`;

    // No guardian address yet: this client can only deploy.
    const deployClient = createGuardianClient({ network: netName, privateKey });
    const guardianDeploy = await deployClient.deployContract("contracts/Guardian.py", []);
    guardianAddress = guardianDeploy.address;
    log("guardian_deployed", { network, address: guardianAddress, tx_hash: guardianDeploy.txHash });

    // Fresh client bound to the newly deployed Guardian, for vault set_guardian + register_target.
    const registryClient = createGuardianClient({
      network: netName,
      privateKey,
      guardianAddress: guardianAddress as `0x${string}`,
    });

    for (const target of spec.targets) {
      const vaultDeploy = await registryClient.deployContract("contracts/ToyVault.py", []);
      log("vault_deployed", { network, target_id: target.target_id, address: vaultDeploy.address, tx_hash: vaultDeploy.txHash });

      await registryClient.setGuardian(vaultDeploy.address as `0x${string}`, guardianAddress as `0x${string}`);
      log("guardian_set", { network, target_id: target.target_id, vault_address: vaultDeploy.address });

      const { txHash } = await registryClient.registerTarget(
        target.target_id,
        vaultDeploy.address as `0x${string}`,
        resolveJsonField(target.manifest),
        resolveJsonField(target.policy),
        target.source_repo || "",
      );
      log("target_registered", { network, target_id: target.target_id, vault_address: vaultDeploy.address, tx_hash: txHash });

      vaults[target.target_id] = vaultDeploy.address;
    }
  } else {
    // signer === "cli": deploy + set_guardian shell out so the CLI's active account
    // (the owner's wallet) signs, without this process ever touching that key.
    // register_target still uses the .env keeper key, since that is the account
    // Guardian expects to call check/register with going forward.
    guardianAddress = cliDeploy("contracts/Guardian.py");
    log("guardian_deployed", { network, address: guardianAddress });

    const privateKey = requireEnv("ACCOUNT_PRIVATE_KEY") as `0x${string}`;
    const registryClient = createGuardianClient({
      network: netName,
      privateKey,
      guardianAddress: guardianAddress as `0x${string}`,
    });

    for (const target of spec.targets) {
      const vaultAddress = cliDeploy("contracts/ToyVault.py");
      log("vault_deployed", { network, target_id: target.target_id, address: vaultAddress });

      cliSetGuardian(vaultAddress, guardianAddress);
      log("guardian_set", { network, target_id: target.target_id, vault_address: vaultAddress });

      const { txHash } = await registryClient.registerTarget(
        target.target_id,
        vaultAddress as `0x${string}`,
        resolveJsonField(target.manifest),
        resolveJsonField(target.policy),
        target.source_repo || "",
      );
      log("target_registered", { network, target_id: target.target_id, vault_address: vaultAddress, tx_hash: txHash });

      vaults[target.target_id] = vaultAddress;
    }
  }

  updateDeploymentsFile(network, signer, guardianAddress, vaults);
  updateSiteConfig(network, guardianAddress, vaults);
  maybeWriteEnvGuardianAddress(network, guardianAddress);

  console.log(JSON.stringify({ network, signer, guardian: guardianAddress, vaults }, null, 2));
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
            trackPending(String(result.txHash), "check");
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
      // deliver any decided PAUSE/RESUME whose appeal window has closed (no-op on Studionet)
      try { await finalizePendingRound(); } catch (e) { log("finalize_round_error", { error: String(e) }); }
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
    case "resume-all":
      return cmdResumeAll(args);
    case "finalize":
      return cmdFinalize(args);
    case "finalize-pending":
      return cmdFinalizePending(args);
    case "update-manifest":
      return cmdUpdateManifest(args);
    case "update-policy":
      return cmdUpdatePolicy(args);
    case "deploy":
      return cmdDeploy(args);
    case "set-guardian":
      return cmdSetGuardian(args);
    case "deploy-all":
      return cmdDeployAll(args);
    default:
      console.error(
        [
          "usage: keeper <command> [args]",
          "  update-manifest <target_id> <manifest.json>   update-policy <target_id> <policy.json>",
          "  resume-all <target_id>   finalize <txId...>   finalize-pending [--until-empty] [--interval 300]",
          "    (deliver on-finalization messages after the appeal window)",
          "",
          "  check <target_id> <source> <incident_id> [--wait-final]",
          "  watch <target_id> [--interval 300]",
          "  verdict <key>",
          "  vault <address>",
          "  register <target_id> <vault_address> <manifest.json path> <policy.json path> [source_repo]",
          "  resume <target_id> <verdict_key>",
          "",
          "  deploy <contracts/File.py> [args...]           deploy a contract, print {address, tx_hash}",
          "  set-guardian <vault_address> <guardian_address>",
          "  deploy-all <network> [--signer env|cli] [--spec docs/examples/deploy-spec.json]",
          "    build a full environment: deploy Guardian, deploy+wire+register every spec target",
        ].join("\n"),
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
