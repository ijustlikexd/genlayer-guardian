// Guardian status site. Read-only: only ever calls readContract, never writeContract.
// Everything address/network-specific comes from ./config.json at runtime so a
// Guardian redeploy only requires editing that file, not rebuilding this script.
import { createClient } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import type { GenLayerChain, GenLayerClient } from "genlayer-js/types";

// ---------------------------------------------------------------- config shapes

interface TargetConfig {
  id: string;
  vault: `0x${string}`;
}

interface NetworkConfig {
  chain: string;
  guardian: `0x${string}`;
  targets: TargetConfig[];
}

interface SiteConfig {
  default_network: string;
  networks: Record<string, NetworkConfig>;
  repo_url?: string;
}

interface ConsistencyRun {
  label: string;
  checks: number;
  targets: number;
  stable_incidents: string;
  accepted: string;
  agree: number;
  disagree: number;
  idle: number;
  agree_share: string;
}

interface ConsistencyPerIncident {
  incident: string;
  result: string;
  disagree_votes?: number;
}

interface V4Retest {
  label: string;
  per_incident: Array<{ incident: string; short?: string; result: string }>;
}

interface BradburyRun {
  label: string;
  real_transactions: number;
  checks: number;
  verdicts_match_studionet_v4: boolean;
  gen_spent: number;
}

interface ConsistencySnapshot {
  source: string;
  runs: ConsistencyRun[];
  v3_per_incident: ConsistencyPerIncident[];
  v4_retest: V4Retest;
  bradbury: BradburyRun;
}

// The LocalStorage key used to persist the user's chosen network across visits.
const NETWORK_STORAGE_KEY = "guardian-network";

// ---------------------------------------------------------------- contract shapes
// Mirrors the dict literals returned by contracts/Guardian.py and contracts/ToyVault.py views.

interface Dependency {
  ecosystem: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

interface Manifest {
  dependencies: Dependency[];
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Policy {
  max_action_on_accepted: string;
  max_action_on_finalized: string;
  min_severity_for_restrict: string;
  min_severity_for_pause: string;
  require_prerequisites_met_for_pause: boolean;
}

interface TargetInfo {
  owner: string;
  address: string;
  manifest: Manifest;
  policy: Policy;
  source_repo: string;
  manifest_version: number;
  policy_version: number;
  enabled: boolean;
}

interface VaultState {
  mode: "NORMAL" | "RESTRICTED" | "PAUSED" | string;
  guardian: string;
  open_incidents: Record<string, string>;
  resolved: string[];
  log: string[];
}

interface Verdict {
  key: string;
  target_id: string;
  source: string;
  incident_id: string;
  applicable: boolean;
  severity_bucket: string;
  prerequisites_met: boolean;
  action: string;
  reason_code: string;
  evidence: Record<string, unknown>;
  manifest_version: number;
  policy_version: number;
  resolved_at: string;
  attempts: number;
  resumed: boolean;
}

// ---------------------------------------------------------------- small dom helpers

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { text?: string; html?: string; className?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.className) node.className = opts.className;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  return node;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function showBanner(message: string): void {
  const banner = $("status-banner");
  banner.textContent = message;
  banner.hidden = false;
}

// Never let a rejected promise reach the console as "uncaught" noise; surface it
// in the UI instead. Belt-and-braces on top of the try/catch in every loader below.
window.addEventListener("unhandledrejection", (event) => {
  console.warn("unhandled rejection", event.reason);
  showBanner(`Unexpected error: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`);
  event.preventDefault();
});

// ---------------------------------------------------------------- state

let config: SiteConfig | null = null;
let currentNetworkKey: string | null = null;
let client: GenLayerClient<GenLayerChain> | null = null;
let consistency: ConsistencySnapshot | null = null;
const targetInfoCache = new Map<string, TargetInfo>();

function activeNetwork(): NetworkConfig {
  if (!config || !currentNetworkKey) throw new Error("config not ready");
  const net = config.networks[currentNetworkKey];
  if (!net) throw new Error(`Unknown network "${currentNetworkKey}"`);
  return net;
}

// ---------------------------------------------------------------- config + client bootstrap

async function loadConfig(): Promise<SiteConfig> {
  const res = await fetch("./config.json");
  if (!res.ok) throw new Error(`config.json fetch failed: ${res.status}`);
  return (await res.json()) as SiteConfig;
}

async function loadConsistency(): Promise<ConsistencySnapshot> {
  const res = await fetch("./consistency.json");
  if (!res.ok) throw new Error(`consistency.json fetch failed: ${res.status}`);
  return (await res.json()) as ConsistencySnapshot;
}

function resolveChain(name: string): GenLayerChain {
  const table = chains as unknown as Record<string, GenLayerChain>;
  // config.json's "chain" field uses the genlayer-js/chains export names
  // (localnet, studionet, testnetAsimov, testnetBradbury).
  const chain = table[name];
  if (!chain) throw new Error(`Unknown chain "${name}" in config.json`);
  return chain;
}

function readStoredNetwork(cfg: SiteConfig): string {
  try {
    const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (stored && cfg.networks[stored]) return stored;
  } catch {
    // localStorage can be unavailable (private mode, disabled storage); fall through.
  }
  return cfg.default_network;
}

function persistNetworkChoice(key: string): void {
  try {
    localStorage.setItem(NETWORK_STORAGE_KEY, key);
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
}

// This page only ever calls readContract. genlayer-js's ClientConfig.account and
// readContract's per-call `account` are both optional (verified against
// node_modules/genlayer-js/dist/index.d.ts and dist/index-C3Ul1Rte.d.ts on the
// 1.1.8 build used here), so no signer, wallet, or throwaway account is needed
// for a read-only client.
function makeClient(net: NetworkConfig): GenLayerClient<GenLayerChain> {
  const chain = resolveChain(net.chain);
  return createClient({ chain: chain as any }) as GenLayerClient<GenLayerChain>;
}

// ---------------------------------------------------------------- contract reads

async function getTarget(targetId: string): Promise<TargetInfo> {
  if (!client) throw new Error("client not ready");
  const result = await client.readContract({
    address: activeNetwork().guardian,
    functionName: "get_target",
    args: [targetId],
  });
  const info = result as unknown as TargetInfo;
  targetInfoCache.set(targetId, info);
  return info;
}

async function getVaultState(vaultAddress: `0x${string}`): Promise<VaultState> {
  if (!client) throw new Error("client not ready");
  const result = await client.readContract({
    address: vaultAddress,
    functionName: "get_state",
    args: [],
  });
  return result as unknown as VaultState;
}

async function verdictKeyFor(targetId: string, source: string, incidentId: string): Promise<string> {
  if (!client) throw new Error("client not ready");
  const result = await client.readContract({
    address: activeNetwork().guardian,
    functionName: "verdict_key_for",
    args: [targetId, source, incidentId],
  });
  return String(result);
}

async function tryGetVerdict(key: string): Promise<Verdict | null> {
  if (!client) throw new Error("client not ready");
  try {
    const result = await client.readContract({
      address: activeNetwork().guardian,
      functionName: "get_verdict",
      args: [key],
    });
    return result as unknown as Verdict;
  } catch {
    // Contract raises UserError("Unknown verdict") for a key that has not been
    // adjudicated yet. Treat any revert here as "not adjudicated", same as the keeper.
    return null;
  }
}

// ---------------------------------------------------------------- OSV (browser-side discovery)

interface OsvVulnSummary {
  id: string;
  severityBucket: string;
  summary: string;
  published: string;
}

const SEVERITY_ORDER: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function normalizeSeverity(s: unknown): string {
  const v = String(s || "").toLowerCase();
  if (v === "medium") return "moderate";
  if (v === "important") return "high";
  return v;
}

function bucketFromOsvVuln(vuln: any): string {
  const dbSpecific = vuln.database_specific || {};
  const sev = normalizeSeverity(dbSpecific.severity);
  if (sev in SEVERITY_ORDER) return sev;
  return ""; // CVSS vector parsing is skipped client-side; shown as "unknown" in the table
}

// Queries OSV for each manifest dependency and returns the canonical advisory ids
// found (aliases are not expanded into separate incidents, matching the keeper fix
// documented in docs/studionet-run-2026-09-04.md).
async function discoverOsvIncidents(deps: Dependency[]): Promise<OsvVulnSummary[]> {
  const byId = new Map<string, OsvVulnSummary>();
  for (const dep of deps) {
    try {
      const res = await fetch("https://api.osv.dev/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: { name: dep.name, ecosystem: dep.ecosystem }, version: dep.version }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const vuln of data.vulns || []) {
        const id = String(vuln.id || "");
        if (!id || byId.has(id)) continue;
        byId.set(id, {
          id,
          severityBucket: bucketFromOsvVuln(vuln),
          summary: String(vuln.summary || ""),
          published: String(vuln.published || ""),
        });
      }
    } catch {
      // OSV unreachable for this dependency; other dependencies still render.
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- rendering: header

function renderHeader(cfg: SiteConfig, networkKey: string): void {
  const net = cfg.networks[networkKey];
  $("network-value").textContent = networkKey;
  $("guardian-value").textContent = net ? net.guardian : "unknown";
  const repoEl = $("repo-value");
  repoEl.textContent = "";
  if (cfg.repo_url) {
    const a = el("a", { text: cfg.repo_url, attrs: { href: cfg.repo_url, target: "_blank", rel: "noopener" } });
    repoEl.appendChild(a);
  } else {
    repoEl.textContent = "not set";
  }
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".network-btn"))) {
    btn.classList.toggle("active", btn.dataset.network === networkKey);
  }
}

function setupNetworkSwitcher(cfg: SiteConfig): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".network-btn"))) {
    const key = btn.dataset.network;
    if (!key || !cfg.networks[key]) {
      btn.disabled = true;
      continue;
    }
    btn.addEventListener("click", () => {
      if (key === currentNetworkKey) return;
      persistNetworkChoice(key);
      switchNetwork(key).catch((err) => {
        showBanner(`Could not switch network: ${describeError(err)}`);
      });
    });
  }
}

// Rebuilds the client for the newly selected network, re-renders targets and the
// Try-it commands, and clears any target-specific incidents panel state (the
// previously selected target belongs to the old network's target list).
async function switchNetwork(networkKey: string): Promise<void> {
  if (!config || !config.networks[networkKey]) throw new Error(`Unknown network "${networkKey}"`);
  currentNetworkKey = networkKey;
  targetInfoCache.clear();
  selectedTargetId = null;

  renderHeader(config, currentNetworkKey);
  client = makeClient(activeNetwork());
  renderTryIt(config, currentNetworkKey);

  const panel = $("incidents-panel");
  panel.innerHTML = "";
  panel.appendChild(el("p", { className: "muted", text: "Select a target above to load its OSV-discovered incidents and verdicts." }));

  await loadTargetsGrid(activeNetwork());
}

// ---------------------------------------------------------------- rendering: targets grid

function modeBadgeClass(mode: string): string {
  const m = mode.toLowerCase();
  if (m === "normal" || m === "restricted" || m === "paused") return `mode-badge mode-${m}`;
  return "mode-badge mode-unknown";
}

function summarizeManifest(manifest: Manifest): string {
  const deps = manifest.dependencies || [];
  const names = deps.map((d) => `${d.name}@${d.version}`).join(", ");
  return names || "(no dependencies)";
}

function summarizeConfig(manifest: Manifest): string {
  const cfg = manifest.config || {};
  const keys = Object.keys(cfg);
  if (keys.length === 0) return "(none)";
  return keys.map((k) => `${k}=${JSON.stringify(cfg[k])}`).join(", ");
}

function summarizePolicy(policy: Policy): string {
  return `restrict>=${policy.min_severity_for_restrict}, pause>=${policy.min_severity_for_pause}` +
    (policy.require_prerequisites_met_for_pause ? ", prereq required for pause" : "");
}

function renderTargetCard(cfgTarget: TargetConfig, info: TargetInfo | null, state: VaultState | null, error: string | null): HTMLElement {
  const card = el("div", { className: "target-card", attrs: { "data-target-id": cfgTarget.id, tabindex: "0", role: "button" } });

  const mode = state?.mode ?? "UNKNOWN";
  const heading = el("h3");
  heading.appendChild(el("span", { text: cfgTarget.id }));
  heading.appendChild(el("span", { text: mode, className: modeBadgeClass(mode) }));
  card.appendChild(heading);

  if (error) {
    card.appendChild(el("p", { className: "error-text", text: error }));
    return card;
  }

  const dl = el("dl");
  const addPair = (term: string, value: string) => {
    dl.appendChild(el("dt", { text: term }));
    dl.appendChild(el("dd", { text: value }));
  };
  addPair("Vault address", cfgTarget.vault);
  if (info) {
    addPair("Manifest deps", summarizeManifest(info.manifest));
    addPair("Config", summarizeConfig(info.manifest));
    addPair("Policy", summarizePolicy(info.policy));
    addPair("Source repo", info.source_repo || "(none)");
  }
  if (state) {
    const openList = Object.entries(state.open_incidents);
    addPair("Open incidents", openList.length ? openList.map(([k, v]) => `${k}: ${v}`).join(", ") : "(none)");
    addPair("Resolved", state.resolved.length ? state.resolved.join(", ") : "(none)");
  }
  card.appendChild(dl);
  return card;
}

async function loadTargetsGrid(cfg: NetworkConfig): Promise<void> {
  const grid = $("targets-grid");
  grid.innerHTML = "";

  const results = await Promise.allSettled(
    cfg.targets.map(async (t) => {
      const [infoRes, stateRes] = await Promise.allSettled([getTarget(t.id), getVaultState(t.vault)]);
      const info = infoRes.status === "fulfilled" ? infoRes.value : null;
      const state = stateRes.status === "fulfilled" ? stateRes.value : null;
      let error: string | null = null;
      if (infoRes.status === "rejected") error = `Guardian.get_target failed: ${describeError(infoRes.reason)}`;
      else if (stateRes.status === "rejected") error = `Vault.get_state failed: ${describeError(stateRes.reason)}`;
      return { target: t, info, state, error };
    }),
  );

  grid.innerHTML = "";
  for (const r of results) {
    if (r.status !== "fulfilled") continue; // the inner Promise.allSettled already caught everything
    const { target, info, state, error } = r.value;
    const card = renderTargetCard(target, info, state, error);
    card.addEventListener("click", () => selectTarget(target.id));
    card.addEventListener("keypress", (e) => {
      if (e.key === "Enter" || e.key === " ") selectTarget(target.id);
    });
    grid.appendChild(card);
  }
  if (grid.children.length === 0) {
    grid.appendChild(el("p", { className: "muted", text: "No targets configured." }));
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------- rendering: incidents panel

let selectedTargetId: string | null = null;

async function selectTarget(targetId: string): Promise<void> {
  selectedTargetId = targetId;
  for (const card of Array.from(document.querySelectorAll(".target-card"))) {
    card.classList.toggle("selected", card.getAttribute("data-target-id") === targetId);
  }
  await renderIncidentsPanel(targetId);
}

function severityCell(bucket: string): string {
  return bucket || "unknown";
}

async function renderIncidentsPanel(targetId: string): Promise<void> {
  const panel = $("incidents-panel");
  panel.innerHTML = "";
  panel.appendChild(el("p", { className: "muted", text: `Loading incidents for ${targetId}...` }));

  try {
    const info = targetInfoCache.get(targetId) ?? (await getTarget(targetId));
    const deps = info.manifest.dependencies || [];
    const discovered = await discoverOsvIncidents(deps);

    const rows: Array<{
      incident: string;
      source: string;
      severity: string;
      applicable: string;
      prereq: string;
      action: string;
      reason: string;
      observedAt: string;
      link: string;
    }> = [];

    for (const adv of discovered) {
      const key = await verdictKeyFor(targetId, "osv", adv.id).catch(() => null);
      const verdict = key ? await tryGetVerdict(key) : null;
      rows.push({
        incident: adv.id,
        source: "osv",
        severity: verdict ? severityCell(verdict.severity_bucket) : severityCell(adv.severityBucket),
        applicable: verdict ? String(verdict.applicable) : "-",
        prereq: verdict ? String(verdict.prerequisites_met) : "-",
        action: verdict ? verdict.action : "not adjudicated",
        reason: verdict ? verdict.reason_code : "-",
        observedAt: verdict ? String(verdict.evidence?.observed_at ?? "-") : "-",
        link: `https://osv.dev/vulnerability/${encodeURIComponent(adv.id)}`,
      });
    }

    panel.innerHTML = "";
    if (info.source_repo) {
      panel.appendChild(
        el("p", {
          className: "muted",
          text: `This target also has a github_repo_advisory source (${info.source_repo}). Use the verdict lookup below to fetch a specific GHSA verdict for it.`,
        }),
      );
    }

    if (rows.length === 0) {
      panel.appendChild(el("p", { className: "muted", text: "OSV reports no known advisories for this target's dependencies." }));
      return;
    }

    const table = el("table");
    const thead = el("thead");
    thead.innerHTML =
      "<tr><th>Incident</th><th>Source</th><th>Severity</th><th>Applicable</th><th>Prereq met</th><th>Action</th><th>Reason</th><th>Observed at</th><th>Link</th></tr>";
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      tr.innerHTML = `
        <td class="mono">${escapeHtml(row.incident)}</td>
        <td>${escapeHtml(row.source)}</td>
        <td>${escapeHtml(row.severity)}</td>
        <td>${escapeHtml(row.applicable)}</td>
        <td>${escapeHtml(row.prereq)}</td>
        <td class="action-tag action-${escapeHtml(row.action)}">${escapeHtml(row.action)}</td>
        <td>${escapeHtml(row.reason)}</td>
        <td>${escapeHtml(row.observedAt)}</td>
        <td><a href="${row.link}" target="_blank" rel="noopener">OSV</a></td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const scrollWrap = el("div", { className: "table-scroll" });
    scrollWrap.appendChild(table);
    panel.appendChild(scrollWrap);
  } catch (err) {
    panel.innerHTML = "";
    panel.appendChild(el("p", { className: "error-text", text: `Could not load incidents: ${describeError(err)}` }));
  }
}

// ---------------------------------------------------------------- verdict lookup box

function setupVerdictLookup(): void {
  const form = $("verdict-lookup-form") as HTMLFormElement;
  const input = $("verdict-key-input") as HTMLInputElement;
  const resultBox = $("verdict-lookup-result");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    resultBox.innerHTML = "";
    if (!key) return;
    resultBox.appendChild(el("p", { className: "muted", text: "Fetching..." }));
    try {
      const verdict = await tryGetVerdict(key);
      resultBox.innerHTML = "";
      if (!verdict) {
        resultBox.appendChild(el("p", { className: "error-text", text: "Unknown verdict (not adjudicated, or the key is malformed)." }));
        return;
      }
      const pre = el("pre", { className: "mono" });
      pre.textContent = JSON.stringify(verdict, null, 2);
      const wrap = el("div", { className: "cli-cmd" });
      wrap.appendChild(pre);
      resultBox.appendChild(wrap);
    } catch (err) {
      resultBox.innerHTML = "";
      resultBox.appendChild(el("p", { className: "error-text", text: describeError(err) }));
    }
  });
}

// ---------------------------------------------------------------- try it panel

function cliCommandRow(cmd: string): HTMLElement {
  const row = el("div", { className: "cli-cmd" });
  const pre = el("pre");
  pre.textContent = cmd;
  row.appendChild(pre);
  const btn = el("button", { text: "Copy", attrs: { type: "button" } });
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    } catch {
      // Clipboard API can be unavailable (insecure context, permissions); fail silently,
      // the command is still visible and selectable by hand.
    }
  });
  row.appendChild(btn);
  return row;
}

function renderTryIt(cfg: SiteConfig, networkKey: string): void {
  const panel = $("tryit-panel");
  panel.innerHTML = "";
  const net = cfg.networks[networkKey];
  if (!net) {
    panel.appendChild(el("p", { className: "error-text", text: `Unknown network "${networkKey}"` }));
    return;
  }
  const sampleTarget = net.targets[0]?.id ?? "vault-a";
  const sampleVault = net.targets[0]?.vault ?? "0x...";
  const sampleIncident = "GHSA-p6mc-m468-83gw"; // the real advisory used throughout docs/studionet-run-2026-09-04.md

  const commands: string[] = [];
  if (networkKey === "testnet-bradbury") {
    commands.push(`npx genlayer network set testnet-bradbury`);
  }
  commands.push(
    `npx genlayer call ${net.guardian} get_target --args ${sampleTarget}`,
    `npx genlayer write ${net.guardian} check --args ${sampleTarget} osv ${sampleIncident}`,
    `npx genlayer call ${net.guardian} get_verdict --args "${sampleTarget}|osv|${sampleIncident}|m1|p1"`,
    `npx genlayer call ${sampleVault} get_state`,
    `npm run keeper -- watch ${sampleTarget} --interval 120`,
  );
  for (const cmd of commands) panel.appendChild(cliCommandRow(cmd));
}

// ---------------------------------------------------------------- consistency panel

function tableInScrollWrap(table: HTMLTableElement): HTMLElement {
  const scrollWrap = el("div", { className: "table-scroll" });
  scrollWrap.appendChild(table);
  return scrollWrap;
}

function renderConsistency(data: ConsistencySnapshot): void {
  const panel = $("consistency-panel");
  panel.innerHTML = "";

  const sourceEl = document.getElementById("consistency-source");
  if (sourceEl) sourceEl.textContent = data.source;

  // ---- comparison table: v2, v3, and the Bradbury re-run ----
  panel.appendChild(el("h3", { text: "Run comparison" }));
  const cmpTable = el("table");
  cmpTable.innerHTML =
    "<thead><tr><th>Run</th><th>Checks</th><th>Targets</th><th>Stable incidents</th><th>Accepted</th><th>AGREE/DISAGREE/IDLE</th><th>AGREE share</th></tr></thead>";
  const cmpBody = el("tbody");
  for (const run of data.runs) {
    const tr = el("tr");
    tr.innerHTML = `
      <td>${escapeHtml(run.label)}</td>
      <td>${run.checks}</td>
      <td>${run.targets}</td>
      <td>${escapeHtml(run.stable_incidents)}</td>
      <td>${escapeHtml(run.accepted)}</td>
      <td>${run.agree}/${run.disagree}/${run.idle}</td>
      <td>${escapeHtml(run.agree_share)}</td>
    `;
    cmpBody.appendChild(tr);
  }
  // Bradbury row: a smaller re-run with no comparable vote-share stats, folded
  // into the same comparison table so it's visible alongside v2/v3 at a glance.
  const b = data.bradbury;
  const bradburyTr = el("tr");
  bradburyTr.innerHTML = `
    <td>${escapeHtml(b.label)}</td>
    <td>${b.checks}</td>
    <td>-</td>
    <td>-</td>
    <td>${b.real_transactions} tx, all ACCEPTED</td>
    <td>-</td>
    <td>${b.verdicts_match_studionet_v4 ? "all verdicts match Studionet v4" : "verdicts differ from Studionet v4"}</td>
  `;
  cmpBody.appendChild(bradburyTr);
  cmpTable.appendChild(cmpBody);
  panel.appendChild(tableInScrollWrap(cmpTable));
  panel.appendChild(el("p", { className: "muted", text: `Bradbury spend: ${b.gen_spent} GEN across ${b.real_transactions} real transactions.` }));

  // ---- per-incident table: v3 ----
  panel.appendChild(el("h3", { text: "Per-incident detail: v3" }));
  const v3Table = el("table");
  v3Table.innerHTML = "<thead><tr><th>Incident</th><th>Result</th><th>Disagree votes</th></tr></thead>";
  const v3Body = el("tbody");
  for (const row of data.v3_per_incident) {
    const tr = el("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(row.incident)}</td>
      <td>${escapeHtml(row.result)}</td>
      <td>${row.disagree_votes ?? "-"}</td>
    `;
    v3Body.appendChild(tr);
  }
  v3Table.appendChild(v3Body);
  panel.appendChild(tableInScrollWrap(v3Table));

  // ---- per-incident table: v4 re-test ----
  panel.appendChild(el("h3", { text: `Per-incident detail: ${data.v4_retest.label}` }));
  const v4Table = el("table");
  v4Table.innerHTML = "<thead><tr><th>Incident</th><th>Result</th></tr></thead>";
  const v4Body = el("tbody");
  for (const row of data.v4_retest.per_incident) {
    const tr = el("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(row.incident)}</td>
      <td>${escapeHtml(row.result)}</td>
    `;
    v4Body.appendChild(tr);
  }
  v4Table.appendChild(v4Body);
  panel.appendChild(tableInScrollWrap(v4Table));

  const src = el("p", { className: "muted" });
  src.textContent = `Source: ${data.source}`;
  panel.appendChild(src);
}

// ---------------------------------------------------------------- boot

async function main(): Promise<void> {
  try {
    config = await loadConfig();
  } catch (err) {
    showBanner(`Could not load config.json: ${describeError(err)}`);
    return;
  }
  currentNetworkKey = readStoredNetwork(config);
  setupNetworkSwitcher(config);
  renderHeader(config, currentNetworkKey);

  try {
    client = makeClient(activeNetwork());
  } catch (err) {
    showBanner(`Could not create GenLayer client: ${describeError(err)}`);
    return;
  }

  setupVerdictLookup();
  renderTryIt(config, currentNetworkKey);

  try {
    consistency = await loadConsistency();
    renderConsistency(consistency);
  } catch (err) {
    $("consistency-panel").appendChild(el("p", { className: "error-text", text: `Could not load consistency.json: ${describeError(err)}` }));
  }

  try {
    await loadTargetsGrid(activeNetwork());
  } catch (err) {
    showBanner(`Could not load targets: ${describeError(err)}`);
  }
}

main().catch((err) => {
  // Last-resort net: main() already catches everything it awaits, but keep this
  // so a bug here never surfaces as a raw unhandled rejection in the console.
  console.error(err);
  showBanner(`Unexpected error: ${describeError(err)}`);
});
