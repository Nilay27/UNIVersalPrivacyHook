import { ethers } from "hardhat";
import { ContractFactory } from "ethers";

// Hook permission flags for Uniswap V4
export const Hooks = {
  BEFORE_INITIALIZE_FLAG: 0x0001,
  AFTER_INITIALIZE_FLAG: 0x0002,
  BEFORE_ADD_LIQUIDITY_FLAG: 0x0004,
  AFTER_ADD_LIQUIDITY_FLAG: 0x0008,
  BEFORE_REMOVE_LIQUIDITY_FLAG: 0x0010,
  AFTER_REMOVE_LIQUIDITY_FLAG: 0x0020,
  BEFORE_SWAP_FLAG: 0x0040,
  AFTER_SWAP_FLAG: 0x0080,
  BEFORE_DONATE_FLAG: 0x0100,
  AFTER_DONATE_FLAG: 0x0200,
  BEFORE_SWAP_RETURNS_DELTA_FLAG: 0x0400,
  AFTER_SWAP_RETURNS_DELTA_FLAG: 0x0800,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG: 0x1000,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG: 0x2000,
};

export function doesAddressStartWith(address: string, prefix: number): boolean {
  const prefixHex = ethers.toBeHex(prefix).slice(2).padStart(4, '0');
  return address.toLowerCase().startsWith('0x' + prefixHex);
}

export async function mineHookAddress(
  factory: ContractFactory,
  poolManagerAddress: string,
  flags: number,
  prefix: number = 0x00,
  maxIterations: number = 10000
): Promise<{ salt: string; expectedAddress: string }> {
  console.log(`Mining for hook address with prefix 0x${prefix.toString(16).padStart(2, '0')}...`);
  
  for (let i = 0; i < maxIterations; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    
    // Calculate the expected address using CREATE2
    const initCodeHash = ethers.keccak256(
      ethers.concat([
        factory.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(["address"], [poolManagerAddress])
      ])
    );
    
    const expectedAddress = ethers.getCreate2Address(
      await factory.runner!.getAddress!(),
      salt,
      initCodeHash
    );
    
    // Check if address matches our requirements
    if (doesAddressStartWith(expectedAddress, prefix)) {
      // Validate hook flags match address bits
      const addressBits = BigInt(expectedAddress) & BigInt(0xffff);
      const flagBits = BigInt(flags);
      
      if ((addressBits & flagBits) === flagBits) {
        console.log(`Found matching address: ${expectedAddress} with salt: ${salt}`);
        return { salt, expectedAddress };
      }
    }
    
    if (i % 1000 === 0) {
      console.log(`Checked ${i} addresses...`);
    }
  }
  
  throw new Error(`Could not find matching address after ${maxIterations} iterations`);
}

export async function deployHookWithMining(
  contractName: string,
  poolManagerAddress: string,
  flags: number,
  prefix: number = 0x00
): Promise<any> {
  const HookFactory = await ethers.getContractFactory(contractName);
  
  const { salt, expectedAddress } = await mineHookAddress(
    HookFactory,
    poolManagerAddress,
    flags,
    prefix
  );
  
  console.log(`Deploying ${contractName} to ${expectedAddress}...`);
  
  const hook = await HookFactory.deploy(poolManagerAddress, {
    gasLimit: 10000000,
    value: 0,
    // @ts-ignore - salt is not in the type definition but works
    salt,
  });
  
  await hook.waitForDeployment();
  const deployedAddress = await hook.getAddress();
  
  if (deployedAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(`Deployed address ${deployedAddress} does not match expected ${expectedAddress}`);
  }
  
  console.log(`${contractName} deployed successfully to: ${deployedAddress}`);
  return hook;
}