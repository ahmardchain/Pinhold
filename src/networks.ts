// Every chain address Pinhold touches, per network profile. Nothing else is called.
// Mainnet addresses were checked by RPC on 20 Nov 2026 (see RULES_CHECK.md).
//
// The testnet profile is split across two chains because Textile's RFQ sandbox only runs on
// BSC testnet, while Self Agent ID and the x402 facilitator run on
// Celo Sepolia. Mainnet runs everything on Celo.

import type { Address } from "./core/types.js";

export type NetworkName = "mainnet" | "testnet";

export interface ChainProfile {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
}

export interface NetworkProfile {
  name: NetworkName;
  // Escrow chain: x402 payments in, refunds out, Self Agent ID registry
  pay: ChainProfile & {
    x402Network: `eip155:${number}`;
    facilitatorUrl: string;
    stable: { address: Address; symbol: string; decimals: number; eip712Name: string; eip712Version: string };
  };
  // FX chain: Textile swap and cNGN payout
  fx: ChainProfile & {
    stable: { address: Address; symbol: string; decimals: number };
    cngn: { address: Address; symbol: string; decimals: number };
    textileApi: string;
  };
  self: { network: "mainnet" | "testnet"; registry: Address; chainId: number };
  erc8004IdentityRegistry: Address;
}

const celoscan = {
  explorerTx: (h: string) => `https://celoscan.io/tx/${h}`,
  explorerAddress: (a: string) => `https://celoscan.io/address/${a}`,
};

export const NETWORKS: Record<NetworkName, NetworkProfile> = {
  mainnet: {
    name: "mainnet",
    pay: {
      chainId: 42220,
      name: "Celo",
      rpcUrl: "https://forno.celo.org",
      ...celoscan,
      x402Network: "eip155:42220",
      facilitatorUrl: "https://api.x402.celo.org",
      // USD₮ on Celo. Not the 18-decimal fee-currency adapter 0x0E2A3e05…6f72.
      stable: {
        address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
        symbol: "USD₮",
        decimals: 6,
        eip712Name: "Tether USD",
        eip712Version: "1",
      },
    },
    fx: {
      chainId: 42220,
      name: "Celo",
      rpcUrl: "https://forno.celo.org",
      ...celoscan,
      stable: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USD₮", decimals: 6 },
      cngn: { address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", symbol: "cNGN", decimals: 6 },
      textileApi: "https://api.textilecredit.com/v2",
    },
    self: { network: "mainnet", registry: "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944", chainId: 42220 },
    erc8004IdentityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  },
  testnet: {
    name: "testnet",
    pay: {
      chainId: 11142220,
      name: "Celo Sepolia",
      rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
      explorerTx: (h) => `https://celo-sepolia.blockscout.com/tx/${h}`,
      explorerAddress: (a) => `https://celo-sepolia.blockscout.com/address/${a}`,
      x402Network: "eip155:11142220",
      facilitatorUrl: "https://api.x402.sepolia.celo.org",
      // USDC is the only x402 asset on Celo Sepolia.
      stable: {
        address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
        symbol: "USDC",
        decimals: 6,
        eip712Name: "USDC",
        eip712Version: "2",
      },
    },
    fx: {
      // Textile's RFQ sandbox: BSC testnet cNGN <-> USDT (Base Sepolia's corridor is not RFQ-enabled).
      // Depth is thin (a few hundred naira), so testnet bookings use small naira prices.
      chainId: 97,
      name: "BSC testnet",
      rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
      explorerTx: (h) => `https://testnet.bscscan.com/tx/${h}`,
      explorerAddress: (a) => `https://testnet.bscscan.com/address/${a}`,
      stable: { address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", symbol: "USDT", decimals: 18 },
      cngn: { address: "0x8a078b182bA9649c03982c2a80CDcc81cdc99dA8", symbol: "cNGN", decimals: 6 },
      textileApi: "https://api.textilecredit.com/v2",
    },
    self: { network: "testnet", registry: "0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379", chainId: 11142220 },
    erc8004IdentityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  },
};
