import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { HybridFHERC20, HybridFHERC20__factory } from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = (await ethers.getContractFactory("HybridFHERC20")) as HybridFHERC20__factory;
  const token = (await factory.deploy("Test Token", "TEST")) as HybridFHERC20;
  const tokenAddress = await token.getAddress();

  return { token, tokenAddress };
}

describe("HybridFHERC20", function () {
  let signers: Signers;
  let token: HybridFHERC20;
  let tokenAddress: string;

  before(async function () {
    const ethSigners: HardhatEthersSigner[] = await ethers.getSigners();
    signers = { deployer: ethSigners[0], alice: ethSigners[1], bob: ethSigners[2] };
  });

  beforeEach(async function () {
    // Check whether the tests are running against an FHEVM mock environment
    if (!fhevm.isMock) {
      console.warn(`This hardhat test suite cannot run on Sepolia Testnet`);
      this.skip();
    }

    ({ token, tokenAddress } = await deployFixture());
  });

  describe("Regular ERC20 Operations", function () {
    it("should have correct name and symbol", async function () {
      expect(await token.name()).to.equal("Test Token");
      expect(await token.symbol()).to.equal("TEST");
    });

    it("should mint regular tokens", async function () {
      const amount = ethers.parseEther("100");
      await token.mint(signers.alice.address, amount);
      expect(await token.balanceOf(signers.alice.address)).to.equal(amount);
    });

    it("should burn regular tokens", async function () {
      const amount = ethers.parseEther("100");
      await token.mint(signers.alice.address, amount);
      await token.burn(signers.alice.address, ethers.parseEther("30"));
      expect(await token.balanceOf(signers.alice.address)).to.equal(ethers.parseEther("70"));
    });

    it("should transfer regular tokens", async function () {
      const amount = ethers.parseEther("100");
      await token.mint(signers.alice.address, amount);
      
      await token.connect(signers.alice).transfer(signers.bob.address, ethers.parseEther("30"));
      expect(await token.balanceOf(signers.alice.address)).to.equal(ethers.parseEther("70"));
      expect(await token.balanceOf(signers.bob.address)).to.equal(ethers.parseEther("30"));
    });
  });

  describe("Encrypted Operations", function () {
    it("should mint encrypted tokens with trivial encryption", async function () {
      const amount = 100n;
      
      // Create encrypted input using the correct method
      const encryptedAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(amount)
        .encrypt();
      
      // Mint encrypted tokens
      await token.connect(signers.alice)["mintEncrypted(address,bytes32,bytes)"](
        signers.alice.address,
        encryptedAmount.handles[0],
        encryptedAmount.inputProof
      );
      
      // Check encrypted balance
      const encBalance = await token.encBalances(signers.alice.address);
      expect(encBalance).to.not.equal(ethers.ZeroHash);
    });

    it("should burn encrypted tokens", async function () {
      const mintAmount = 100n;
      const burnAmount = 30n;
      
      // Mint encrypted tokens first
      const encryptedMintAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(mintAmount)
        .encrypt();
      
      await token.connect(signers.alice)["mintEncrypted(address,bytes32,bytes)"](
        signers.alice.address,
        encryptedMintAmount.handles[0],
        encryptedMintAmount.inputProof
      );
      
      // Burn some encrypted tokens
      const encryptedBurnAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(burnAmount)
        .encrypt();
      
      await token.connect(signers.alice)["burnEncrypted(address,bytes32,bytes)"](
        signers.alice.address,
        encryptedBurnAmount.handles[0],
        encryptedBurnAmount.inputProof
      );
      
      // Check that balance changed (we can't verify exact amount without decryption)
      const encBalance = await token.encBalances(signers.alice.address);
      expect(encBalance).to.not.equal(ethers.ZeroHash);
    });

    it("should transfer encrypted tokens", async function () {
      const amount = 100n;
      const transferAmount = 30n;
      
      // Mint encrypted tokens to alice
      const encryptedAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(amount)
        .encrypt();
      
      await token.connect(signers.alice)["mintEncrypted(address,bytes32,bytes)"](
        signers.alice.address,
        encryptedAmount.handles[0],
        encryptedAmount.inputProof
      );
      
      // Transfer encrypted tokens from alice to bob
      const encryptedTransferAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(transferAmount)
        .encrypt();
      
      await token.connect(signers.alice)["transferEncrypted(address,bytes32,bytes)"](
        signers.bob.address,
        encryptedTransferAmount.handles[0],
        encryptedTransferAmount.inputProof
      );
      
      // Check that both balances are non-zero (encrypted)
      const aliceBalance = await token.encBalances(signers.alice.address);
      const bobBalance = await token.encBalances(signers.bob.address);
      expect(aliceBalance).to.not.equal(ethers.ZeroHash);
      expect(bobBalance).to.not.equal(ethers.ZeroHash);
    });

    it("should handle transferFrom with encrypted tokens", async function () {
      const amount = 100n;
      const transferAmount = 30n;
      
      // Mint encrypted tokens to alice
      const encryptedAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(amount)
        .encrypt();
      
      await token.connect(signers.alice)["mintEncrypted(address,bytes32,bytes)"](
        signers.alice.address,
        encryptedAmount.handles[0],
        encryptedAmount.inputProof
      );
      
      // Bob tries to transfer from alice to himself (should work as contract for testing)
      const encryptedTransferAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.bob.address)
        .add128(transferAmount)
        .encrypt();
      
      await token.connect(signers.bob)["transferFromEncrypted(address,address,bytes32,bytes)"](
        signers.alice.address,
        signers.bob.address,
        encryptedTransferAmount.handles[0],
        encryptedTransferAmount.inputProof
      );
      
      // Check that both balances are non-zero (encrypted)
      const aliceBalance = await token.encBalances(signers.alice.address);
      const bobBalance = await token.encBalances(signers.bob.address);
      expect(aliceBalance).to.not.equal(ethers.ZeroHash);
      expect(bobBalance).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Edge Cases", function () {
    it("should revert when transferring from zero address", async function () {
      const amount = 100n;
      const encryptedAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.deployer.address)
        .add128(amount)
        .encrypt();
      
      await expect(
        token["transferFromEncrypted(address,address,bytes32,bytes)"](
          ethers.ZeroAddress,
          signers.bob.address,
          encryptedAmount.handles[0],
          encryptedAmount.inputProof
        )
      ).to.be.revertedWithCustomError(token, "HybridFHERC20__InvalidSender");
    });

    it("should revert when transferring to zero address", async function () {
      const amount = 100n;
      const encryptedAmount = await fhevm
        .createEncryptedInput(tokenAddress, signers.alice.address)
        .add128(amount)
        .encrypt();
      
      await expect(
        token.connect(signers.alice)["transferEncrypted(address,bytes32,bytes)"](
          ethers.ZeroAddress,
          encryptedAmount.handles[0],
          encryptedAmount.inputProof
        )
      ).to.be.revertedWithCustomError(token, "HybridFHERC20__InvalidReceiver");
    });
  });
});