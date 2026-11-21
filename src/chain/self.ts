// Self Agent ID: who gets served and who gets paid.
//  - Sponsors' agents: SelfAgentVerifier checks each signed request (signature, registry,
//    proof freshness). We then read the human nullifier from the registry ourselves, because
//    the per-person limit is ours (one open escrow per human, across all their agents).
//  - Channel owners: a registry read before every payout. The owner's Self agent NFT must be
//    owned by the payout wallet, and its proof must be fresh.
// Docs: https://docs.self.xyz/docs/agent-id/overview/

import { SelfAgentVerifier } from "@selfxyz/agent-sdk";
import { createPublicClient, http, pad, parseAbi, type PublicClient } from "viem";
import type { OwnerProof, SponsorIdentity } from "../core/policy.js";
import type { Address } from "../core/types.js";

const REGISTRY_ABI = parseAbi([
  "function isVerifiedAgent(bytes32 agentPubKey) view returns (bool)",
  "function getAgentId(bytes32 agentPubKey) view returns (uint256)",
  "function hasHumanProof(uint256 agentId) view returns (bool)",
  "function isProofFresh(uint256 agentId) view returns (bool)",
  "function getHumanNullifier(uint256 agentId) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

export interface SignedRequest {
  signature: string;
  timestamp: string;
  method: string;
  url: string; // path + query, as the agent signed it
  body: string; // the raw body bytes as received
}

export interface IdentityService {
  verifySponsor(req: SignedRequest): Promise<SponsorIdentity>;
  ownerProof(agentId: string): Promise<OwnerProof | null>;
}

export class SelfIdentity implements IdentityService {
  private readonly verifier;
  private readonly client: PublicClient;

  constructor(private readonly o: { network: "mainnet" | "testnet"; registry: Address; rpcUrl: string }) {
    // sybilLimit(0): Self's verifier would otherwise reject humans who hold several agents.
    // Our own limit is per human (nullifier), enforced in admitBooking.
    this.verifier = SelfAgentVerifier.create().network(o.network).sybilLimit(0).build();
    this.client = createPublicClient({ transport: http(o.rpcUrl) }) as PublicClient;
  }

  async verifySponsor(req: SignedRequest): Promise<SponsorIdentity> {
    const r = await this.verifier.verify({
      signature: req.signature,
      timestamp: req.timestamp,
      method: req.method,
      url: req.url,
      body: req.body,
    });
    if (!r.valid || r.agentId === 0n) {
      return { valid: false, error: r.error, agentId: r.agentId, agentAddress: r.agentAddress, nullifier: 0n };
    }
    // Registry read: the human behind this agent (same value for all of that human's agents).
    const nullifier = await this.client.readContract({
      address: this.o.registry, abi: REGISTRY_ABI, functionName: "getHumanNullifier", args: [r.agentId],
    });
    return { valid: true, agentId: r.agentId, agentAddress: r.agentAddress, nullifier };
  }

  async ownerProof(agentId: string): Promise<OwnerProof | null> {
    const id = BigInt(agentId);
    try {
      const [nftOwner, hasHumanProof, proofFresh] = await Promise.all([
        this.client.readContract({ address: this.o.registry, abi: REGISTRY_ABI, functionName: "ownerOf", args: [id] }),
        this.client.readContract({ address: this.o.registry, abi: REGISTRY_ABI, functionName: "hasHumanProof", args: [id] }),
        this.client.readContract({ address: this.o.registry, abi: REGISTRY_ABI, functionName: "isProofFresh", args: [id] }),
      ]);
      return { agentId: id, nftOwner: nftOwner as Address, hasHumanProof, proofFresh };
    } catch {
      return null; // burned / never minted
    }
  }

  async agentIdForAddress(address: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.o.registry, abi: REGISTRY_ABI, functionName: "getAgentId", args: [pad(address, { size: 32 })],
    });
  }
}

/** Dry-run identity: agents listed in `verified` pass; everyone else is turned away. */
export class MockIdentity implements IdentityService {
  constructor(
    private readonly verified: Map<string, { agentId: bigint; nullifier: bigint }>,
    private readonly owners: Map<string, OwnerProof>,
  ) {}

  async verifySponsor(req: SignedRequest): Promise<SponsorIdentity> {
    // In dry runs the "signature" header carries the agent address.
    const hit = this.verified.get(req.signature.toLowerCase());
    if (!hit) return { valid: false, error: "Agent not verified on-chain", agentId: 0n, agentAddress: req.signature, nullifier: 0n };
    return { valid: true, agentId: hit.agentId, agentAddress: req.signature, nullifier: hit.nullifier };
  }

  async ownerProof(agentId: string) {
    return this.owners.get(agentId) ?? null;
  }
}
