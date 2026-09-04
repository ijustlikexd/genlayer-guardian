// Typed wrapper over genlayer-js for the Guardian and ToyVault contracts.
//
// Exact genlayer-js 1.1.x exports used here (pattern copied from
// genlayer-resolver/client/genlayer-client.ts, verified there against
// node_modules/genlayer-js/dist/*.d.ts):
//   - createClient(config)      from "genlayer-js"
//   - createAccount(privateKey) from "genlayer-js"
//   - localnet, studionet, testnetAsimov, testnetBradbury
//                                from "genlayer-js/chains"
//   - TransactionStatus, TransactionHash, GenLayerClient, GenLayerChain
//                                from "genlayer-js/types"
//
// client.readContract / client.writeContract / client.waitForTransactionReceipt
// are methods on the GenLayerClient object returned by createClient.
// writeContract requires a `value: bigint` field (0n for a plain call).

import { createClient, createAccount } from "genlayer-js";
import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import type {
  GenLayerClient,
  GenLayerChain,
  TransactionHash,
  GenLayerTransaction,
} from "genlayer-js/types";
import { TransactionStatus } from "genlayer-js/types";

export type NetworkName = "localnet" | "studionet" | "testnet-asimov" | "testnet-bradbury";

const CHAIN_BY_NAME: Record<NetworkName, GenLayerChain> = {
  localnet: localnet,
  studionet: studionet,
  "testnet-asimov": testnetAsimov,
  "testnet-bradbury": testnetBradbury,
};

export interface CreateGuardianClientOptions {
  network: NetworkName | GenLayerChain;
  privateKey: `0x${string}`;
  guardianAddress?: `0x${string}`;
}

// ---- Shapes mirroring contracts/Guardian.py return dicts (see get_target,
// get_verdict). Kept loose (Record for nested json) since the contract does
// not publish a formal schema beyond these dict literals.

export interface Dependency {
  ecosystem: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface Manifest {
  dependencies: Dependency[];
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Policy {
  max_action_on_accepted: "NONE" | "RESTRICT";
  max_action_on_finalized: "NONE" | "RESTRICT" | "PAUSE";
  min_severity_for_restrict: string;
  min_severity_for_pause: string;
  require_prerequisites_met_for_pause: boolean;
}

export interface TargetInfo {
  owner: string;
  address: string;
  manifest: Manifest;
  policy: Policy;
  source_repo: string;
  manifest_version: number;
  policy_version: number;
  enabled: boolean;
}

export interface Verdict {
  key: string;
  target_id: string;
  source: string;
  incident_id: string;
  applicable: boolean;
  severity_bucket: string;
  prerequisites_met: boolean;
  action: "NONE" | "RESTRICT" | "PAUSE" | "INSUFFICIENT_EVIDENCE";
  reason_code: string;
  evidence: Record<string, unknown>;
  manifest_version: number;
  policy_version: number;
  resolved_at: string;
  attempts: number;
  resumed: boolean;
}

export interface VaultState {
  mode: "NORMAL" | "RESTRICTED" | "PAUSED";
  guardian: string;
  open_incidents: Record<string, string>;
  resolved: string[];
  log: string[];
}

export type Source = "osv" | "github_repo_advisory";

export interface CheckResult {
  verdictKey: string;
  txHash: string;
  submitTime: string;
  acceptedTime: string;
  acceptedReceipt: GenLayerTransaction;
}

export interface GuardianClient {
  raw: GenLayerClient<any>;
  guardianAddress: `0x${string}` | undefined;

  getTarget(targetId: string): Promise<TargetInfo>;
  verdictKeyFor(targetId: string, source: Source, incidentId: string): Promise<string>;
  getVerdict(key: string): Promise<Verdict>;
  tryGetVerdict(key: string): Promise<Verdict | null>;

  check(targetId: string, source: Source, incidentId: string): Promise<CheckResult>;
  waitFinalized(txHash: string): Promise<{ receipt: GenLayerTransaction; finalizedTime: string }>;

  registerTarget(
    targetId: string,
    targetAddress: `0x${string}`,
    manifestJson: string,
    policyJson: string,
    sourceRepo: string,
  ): Promise<{ txHash: string }>;

  requestResume(targetId: string, verdictKey: string): Promise<{ reasonCode: string; txHash: string }>;
  finalize(txId: string): Promise<{ ok: boolean; evmTx?: string; error?: string }>;
  updateManifest(targetId: string, manifestJson: string): Promise<{ txHash: string }>;
  updatePolicy(targetId: string, policyJson: string): Promise<{ txHash: string }>;

  readVaultState(vaultAddress: `0x${string}`): Promise<VaultState>;
  readVaultMode(vaultAddress: `0x${string}`): Promise<string>;
}

function resolveChain(network: NetworkName | GenLayerChain): GenLayerChain {
  if (typeof network === "string") {
    const chain = CHAIN_BY_NAME[network];
    if (!chain) {
      throw new Error(`Unknown network name: ${network}`);
    }
    return chain;
  }
  return network;
}

// A write can be ACCEPTED by consensus while the contract itself rolled back or crashed.
// Scan the receipt for leader execution errors and surface them instead of reporting success.
export function assertExecuted(receipt: unknown, what: string): void {
  const seen = new Set<unknown>();
  const errors: string[] = [];
  const walk = (node: any, depth: number): void => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return;
    seen.add(node);
    if (node.execution_result === "ERROR" && node.mode !== "validator") {
      const r = node.result;
      const payload = r && typeof r === "object" ? r.payload : r;
      errors.push(typeof payload === "string" ? payload : JSON.stringify(payload ?? "ERROR"));
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(receipt, 0);
  const real = errors.filter((e) => e !== "idle");
  if (real.length) throw new Error(`${what} failed on-chain: ${real[0]}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createGuardianClient(options: CreateGuardianClientOptions): GuardianClient {
  const chain = resolveChain(options.network);
  const account = createAccount(options.privateKey);

  const client = createClient({
    chain: chain as any,
    account,
  }) as GenLayerClient<any>;

  function requireAddress(): `0x${string}` {
    if (!options.guardianAddress) {
      throw new Error("guardianAddress is required for this operation");
    }
    return options.guardianAddress;
  }

  async function pollVerdict(key: string, attempts: number, delayMs: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        await client.readContract({ address: requireAddress(), functionName: "get_verdict", args: [key] });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return false;
  }

  // Generic owner write: submit, wait ACCEPTED, surface on-chain rollbacks.
  async function simpleWrite(functionName: string, args: unknown[]): Promise<{ txHash: string }> {
    const address = requireAddress();
    const txHash = await client.writeContract({ address, functionName, args: args as any, value: 0n });
    const rcpt = await client.waitForTransactionReceipt({
      hash: txHash as TransactionHash,
      status: TransactionStatus.ACCEPTED,
      retries: 200,
    });
    assertExecuted(rcpt, functionName);
    return { txHash: String(txHash) };
  }

  return {
    raw: client,
    guardianAddress: options.guardianAddress,

    async getTarget(targetId: string): Promise<TargetInfo> {
      const result = await client.readContract({
        address: requireAddress(),
        functionName: "get_target",
        args: [targetId],
      });
      return result as unknown as TargetInfo;
    },

    async verdictKeyFor(targetId: string, source: Source, incidentId: string): Promise<string> {
      const result = await client.readContract({
        address: requireAddress(),
        functionName: "verdict_key_for",
        args: [targetId, source, incidentId],
      });
      return String(result);
    },

    async getVerdict(key: string): Promise<Verdict> {
      const result = await client.readContract({
        address: requireAddress(),
        functionName: "get_verdict",
        args: [key],
      });
      return result as unknown as Verdict;
    },

    async tryGetVerdict(key: string): Promise<Verdict | null> {
      try {
        const result = await client.readContract({
          address: requireAddress(),
          functionName: "get_verdict",
          args: [key],
        });
        return result as unknown as Verdict;
      } catch {
        // Unknown verdict (contract raises UserError) or a transient revert.
        // The keeper treats both as "no verdict yet" per spec.
        return null;
      }
    },

    async check(targetId: string, source: Source, incidentId: string): Promise<CheckResult> {
      const address = requireAddress();
      const submitTime = nowIso();

      const txHash = await client.writeContract({
        address,
        functionName: "check",
        args: [targetId, source, incidentId],
        value: 0n,
      });

      const verdictKey = await client.readContract({
        address,
        functionName: "verdict_key_for",
        args: [targetId, source, incidentId],
      });

      let acceptedReceipt: GenLayerTransaction | undefined;
      try {
        acceptedReceipt = await client.waitForTransactionReceipt({
          hash: txHash as TransactionHash,
          status: TransactionStatus.ACCEPTED,
          retries: 200,
        });
        assertExecuted(acceptedReceipt, "check");
      } catch (err) {
        // Bradbury can report LEADER_TIMEOUT to the client while the round still completes
        // through rotation. Confirm by polling the verdict before treating this as a failure.
        const found = await pollVerdict(String(verdictKey), 12, 15_000);
        if (!found) throw err;
      }
      const acceptedTime = nowIso();

      return {
        verdictKey: String(verdictKey),
        txHash: String(txHash),
        submitTime,
        acceptedTime,
        acceptedReceipt: acceptedReceipt as GenLayerTransaction,
      };
    },

    async waitFinalized(txHash: string): Promise<{ receipt: GenLayerTransaction; finalizedTime: string }> {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash as TransactionHash,
        status: TransactionStatus.FINALIZED,
        retries: 200,
      });
      return { receipt, finalizedTime: nowIso() };
    },

    async registerTarget(
      targetId: string,
      targetAddress: `0x${string}`,
      manifestJson: string,
      policyJson: string,
      sourceRepo: string,
    ): Promise<{ txHash: string }> {
      const address = requireAddress();
      const txHash = await client.writeContract({
        address,
        functionName: "register_target",
        args: [targetId, targetAddress, manifestJson, policyJson, sourceRepo],
        value: 0n,
      });
      const rcpt_reg = await client.waitForTransactionReceipt({
        hash: txHash as TransactionHash,
        status: TransactionStatus.ACCEPTED,
        retries: 200,
      });
      assertExecuted(rcpt_reg, "register_target");
      return { txHash: String(txHash) };
    },

    async finalize(txId: string): Promise<{ ok: boolean; evmTx?: string; error?: string }> {
      // Permissionless, decision-bound: delivers on-finalization messages once the appeal window
      // has closed. Reverts while the window is open; that is expected, retry later.
      try {
        const evmTx = await client.finalizeTransaction({ txId: txId as `0x${string}` });
        return { ok: true, evmTx: String(evmTx) };
      } catch (err: any) {
        return { ok: false, error: String(err?.shortMessage ?? err?.message ?? err) };
      }
    },

    async updateManifest(targetId: string, manifestJson: string): Promise<{ txHash: string }> {
      return simpleWrite("update_manifest", [targetId, manifestJson]);
    },

    async updatePolicy(targetId: string, policyJson: string): Promise<{ txHash: string }> {
      return simpleWrite("update_policy", [targetId, policyJson]);
    },

    async requestResume(targetId: string, verdictKey: string): Promise<{ reasonCode: string; txHash: string }> {
      // The write's return value (reason code) is not reliably exposed on the receipt, so confirm
      // the effect instead: the verdict record flips `resumed` to true when RESUME was emitted.
      const { txHash } = await simpleWrite("request_resume", [targetId, verdictKey]);
      const v = await this.tryGetVerdict(verdictKey);
      return { reasonCode: v?.resumed ? "RESUMED" : "UNKNOWN", txHash };
    },


    async readVaultState(vaultAddress: `0x${string}`): Promise<VaultState> {
      const result = await client.readContract({
        address: vaultAddress,
        functionName: "get_state",
        args: [],
      });
      return result as unknown as VaultState;
    },

    async readVaultMode(vaultAddress: `0x${string}`): Promise<string> {
      const result = await client.readContract({
        address: vaultAddress,
        functionName: "get_mode",
        args: [],
      });
      return String(result);
    },
  };
}
