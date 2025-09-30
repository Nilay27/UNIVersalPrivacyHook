import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import "hardhat-contract-sizer";
import type { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "solidity-coverage";
import * as dotenv from "dotenv";

import "./tasks/accounts";
import "./tasks/FHECounter";
import "./tasks/UniversalPrivacyHook";

// Load .env file if it exists
dotenv.config();

// Support both .env and hardhat vars
// Run 'npx hardhat vars setup' to see the list of variables that need to be set

const MNEMONIC: string = process.env.MNEMONIC || vars.get("MNEMONIC", "test test test test test test test test test test test junk");
const PRIVATE_KEY: string = process.env.PRIVATE_KEY || vars.get("PRIVATE_KEY", "");
const ANKR_API_KEY: string = process.env.ANKR_API_KEY || vars.get("ANKR_API_KEY", "");

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: 0,
  },
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || vars.get("ETHERSCAN_API_KEY", ""),
    },
  },
  gasReporter: {
    currency: "USD",
    enabled: process.env.REPORT_GAS ? true : false,
    excludeContracts: [],
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: MNEMONIC,
      },
      chainId: 31337,
      forking: process.env.FORK_SEPOLIA ? {
        url: ANKR_API_KEY ? `https://rpc.ankr.com/eth_sepolia/${ANKR_API_KEY}` : "https://rpc.ankr.com/eth_sepolia",
        blockNumber: 9283500 // Fixed block for consistent testing
      } : undefined,
    },
    anvil: {
      accounts: {
        mnemonic: MNEMONIC,
        path: "m/44'/60'/0'/0/",
        count: 10,
      },
      chainId: 31337,
      url: "http://localhost:8545",
    },
    sepolia: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : {
        mnemonic: MNEMONIC,
        path: "m/44'/60'/0'/0/",
        count: 10,
      },
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
        // Not including the metadata hash
        // https://github.com/paulrberg/hardhat-template/issues/31
        bytecodeHash: "none",
      },
      // Disable the optimizer when debugging
      // https://hardhat.org/hardhat-network/#solidity-optimizer-support
      optimizer: {
        enabled: true,
        runs: 800,
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
