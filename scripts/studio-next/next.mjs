// Guardian on GenLayer Studio Next (chain 61997, https://studio-dev.genlayer.com/api).
//
// Studio Next runs the fee-aware ConsensusMain, which genlayer-js 1.1.8 (used by keeper/)
// cannot drive (FeesDistributionMissing / FeeValueMustBeNonZero). This side-driver uses
// genlayer-js 2.0.0-rc.1 (studioDevnet chain + estimateTransactionFees) and mirrors the
// keeper's deploy-all / check / verdict / vault commands. Same contracts, same keeper key.
//
//   node next.mjs fund                       # sim_fundAccount for the keeper key (Studio faucet)
//   node next.mjs deploy-all                 # Guardian + one ToyVault per spec target, wired + registered
//   node next.mjs check <target> <source> <incident> [--wait-final]
//   node next.mjs verdict <key> | vault <address> | target <id>
import { createClient, createAccount } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf-8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => l.split("=", 2).map((x) => x.trim())),
);
const DEPLOYMENTS = path.join(ROOT, "deployments.json");
const SITE_CONFIG = path.join(ROOT, "site/public/config.json");
const NETWORK = "studio-next";
const account = createAccount(env.ACCOUNT_PRIVATE_KEY);
const client = createClient({ chain: studioDevnet, account });
const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, network: NETWORK, ...fields }));
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function fees() { return client.estimateTransactionFees(); }
async function waitDecided(hash) {
  return client.waitForTransactionReceipt({ hash, waitUntil: "decided", retries: 300 });
}
async function waitFinalized(hash) {
  return client.waitForTransactionReceipt({ hash, waitUntil: "finalized", retries: 600 });
}
// Same rollback detection as keeper/client.ts assertExecuted.
function assertExecuted(receipt, what) {
  const seen = new Set(); const errors = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return;
    seen.add(node);
    if (node.execution_result === "ERROR" && node.mode !== "validator") {
      const r = node.result; const payload = r && typeof r === "object" ? r.payload : r;
      errors.push(typeof payload === "string" ? payload : JSON.stringify(payload ?? "ERROR"));
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(receipt, 0);
  const real = errors.filter((e) => e !== "idle");
  if (real.length) throw new Error(`${what} rolled back on-chain: ${real[0]}`);
}
async function deploy(file) {
  const code = new Uint8Array(readFileSync(path.join(ROOT, file)));
  const hash = await client.deployContract({ code, args: [], fees: await fees() });
  const r = await waitDecided(hash);
  assertExecuted(r, `deploy ${file}`);
  const address = r.txDataDecoded?.contractAddress ?? r.data?.contract_address;
  if (!address) throw new Error("no contract address in receipt");
  return { address: String(address), txHash: String(hash) };
}
async function write(address, functionName, args, { final = false } = {}) {
  const hash = await client.writeContract({ address, functionName, args, value: 0n, fees: await fees() });
  const r = await waitDecided(hash);
  assertExecuted(r, functionName);
  return { txHash: String(hash), receipt: r, finalReceipt: final ? await waitFinalized(hash) : null };
}
const read = (address, functionName, args) => client.readContract({ address, functionName, args });
const jsonField = (v) => (typeof v === "string" ? readFileSync(path.join(ROOT, v), "utf-8").trim() : JSON.stringify(v));

async function cmdFund() {
  const res = await client.request({ method: "sim_fundAccount", params: [account.address, 1000000000000000000000] });
  const bal = await client.request({ method: "eth_getBalance", params: [account.address, "latest"] });
  log("funded", { address: account.address, tx: res, balance_gen: Number(BigInt(bal)) / 1e18 });
}

async function cmdDeployAll() {
  const spec = JSON.parse(readFileSync(path.join(ROOT, "docs/examples/deploy-spec.json"), "utf-8"));
  const g = await deploy("contracts/Guardian.py");
  log("guardian_deployed", { address: g.address, tx_hash: g.txHash });
  const vaults = {};
  for (const t of spec.targets) {
    const v = await deploy("contracts/ToyVault.py");
    log("vault_deployed", { target_id: t.target_id, address: v.address, tx_hash: v.txHash });
    await write(v.address, "set_guardian", [g.address]);
    log("guardian_set", { target_id: t.target_id, vault_address: v.address });
    const reg = await write(g.address, "register_target", [t.target_id, v.address, jsonField(t.manifest), jsonField(t.policy), t.source_repo || ""]);
    log("target_registered", { target_id: t.target_id, vault_address: v.address, tx_hash: reg.txHash });
    vaults[t.target_id] = v.address;
  }
  // deployments.json
  const dep = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf-8")) : { current: {}, history: [] };
  dep.current[NETWORK] = { guardian: g.address, vaults, deployedAt: new Date().toISOString(), signer: "env", genlayerJs: "2.0.0-rc.1" };
  writeFileSync(DEPLOYMENTS, JSON.stringify(dep, null, 2) + "\n");
  // site config
  const cfg = JSON.parse(readFileSync(SITE_CONFIG, "utf-8"));
  cfg.networks[NETWORK] = { chain: "studioNext", guardian: g.address, targets: Object.entries(vaults).map(([id, vault]) => ({ id, vault })) };
  writeFileSync(SITE_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  console.log(json({ network: NETWORK, guardian: g.address, vaults }));
}

function guardianAddress() {
  const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf-8"));
  const g = dep.current?.[NETWORK]?.guardian;
  if (!g) throw new Error("no studio-next guardian in deployments.json; run deploy-all first");
  return g;
}

async function cmdCheck([targetId, source, incidentId, ...flags]) {
  const g = guardianAddress();
  const submit = new Date().toISOString();
  const res = await write(g, "check", [targetId, source, incidentId], { final: flags.includes("--wait-final") });
  const key = await read(g, "verdict_key_for", [targetId, source, incidentId]);
  log("check_submitted", { target_id: targetId, source, incident_id: incidentId, submit_time: submit, accepted_time: new Date().toISOString(), tx_hash: res.txHash, verdict_key: key });
  console.log(json(await read(g, "get_verdict", [key])));
  if (res.finalReceipt) log("check_finalized", { target_id: targetId, verdict_key: key, finalized_time: new Date().toISOString() });
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "fund") await cmdFund();
  else if (cmd === "deploy-all") await cmdDeployAll();
  else if (cmd === "check") await cmdCheck(args);
  else if (cmd === "deploy") { const r = await deploy(args[0]); log("deployed", { file: args[0], ...r }); }
  else if (cmd === "verdict") console.log(json(await read(guardianAddress(), "get_verdict", [args[0]])));
  else if (cmd === "target") console.log(json(await read(guardianAddress(), "get_target", [args[0]])));
  else if (cmd === "vault") console.log(json(await read(args[0], "get_state", [])));
  else { console.error("usage: node next.mjs fund | deploy-all | check <target> <source> <incident> [--wait-final] | verdict <key> | target <id> | vault <address>"); process.exit(1); }
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
