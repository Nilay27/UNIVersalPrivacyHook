// Sepolia deployment config without FHEVM plugin
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import type { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "solidity-coverage";
import * as dotenv from "dotenv";

// Load .env file if it exists
dotenv.config();

// Support both .env and hardhat vars
const PRIVATE_KEY: string = process.env.PRIVATE_KEY || vars.get("PRIVATE_KEY", "");
const ANKR_API_KEY: string = process.env.ANKR_API_KEY || vars.get("ANKR_API_KEY", "");

const config: HardhatUserConfig = {
  defaultNetwork: "sepolia",
  namedAccounts: {
    deployer: 0,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || vars.get("ETHERSCAN_API_KEY", ""),
  },
  networks: {
    sepolia: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
      url: ANKR_API_KEY ? `https://rpc.ankr.com/eth_sepolia/${ANKR_API_KEY}` : "https://rpc.ankr.com/eth_sepolia",
    },
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.25",
    settings: {
      metadata: {
        bytecodeHash: "none",
      },
      optimizer: {
        enabled: true,
        runs: 200, // Lower runs for deployment
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
};

export default config;