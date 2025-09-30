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
  const token = (await factory.deploy("Test Token", "TEST", 6)) as HybridFHERC20; // Add decimals parameter
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

    it("should have correct decimals", async function () {
      expect(await token.decimals()).to.equal(6);
    });

    it("should start with zero total supply", async function () {
      expect(await token.totalSupply()).to.equal(0);
    });

    it("should mint regular tokens", async function () {
      const amount = ethers.parseUnits("100", 6);
      await token.mint(signers.alice.address, amount);
      expect(await token.balanceOf(signers.alice.address)).to.equal(amount);
      expect(await token.totalSupply()).to.equal(amount);
    });

    it("should mint to multiple users", async function () {
      const amount1 = ethers.parseUnits("100", 6);
      const amount2 = ethers.parseUnits("200", 6);

      await token.mint(signers.alice.address, amount1);
      await token.mint(signers.bob.address, amount2);

      expect(await token.balanceOf(signers.alice.address)).to.equal(amount1);
      expect(await token.balanceOf(signers.bob.address)).to.equal(amount2);
      expect(await token.totalSupply()).to.equal(amount1 + amount2);
    });

    it("should burn regular tokens", async function () {
      const amount = ethers.parseUnits("100", 6);
      await token.mint(signers.alice.address, amount);
      await token.burn(signers.alice.address, ethers.parseUnits("30", 6));

      expect(await token.balanceOf(signers.alice.address)).to.equal(ethers.parseUnits("70", 6));
      expect(await token.totalSupply()).to.equal(ethers.parseUnits("70", 6));
    });

    it("should burn all tokens", async function () {
      const amount = ethers.parseUnits("100", 6);
      await token.mint(signers.alice.address, amount);
      await token.burn(signers.alice.address, amount);

      expect(await token.balanceOf(signers.alice.address)).to.equal(0);
      expect(await token.totalSupply()).to.equal(0);
    });

    it("should transfer regular tokens", async function () {
      const amount = ethers.parseUnits("100", 6);
      await token.mint(signers.alice.address, amount);

      await token.connect(signers.alice).transfer(signers.bob.address, ethers.parseUnits("30", 6));
      expect(await token.balanceOf(signers.alice.address)).to.equal(ethers.parseUnits("70", 6));
      expect(await token.balanceOf(signers.bob.address)).to.equal(ethers.parseUnits("30", 6));
    });

    it("should emit Transfer event on mint", async function () {
      const amount = ethers.parseUnits("100", 6);
      await expect(token.mint(signers.alice.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, signers.alice.address, amount);
    });

    it("should emit Transfer event on burn", async function () {
      const amount = ethers.parseUnits("100", 6);
      await token.mint(signers.alice.address, amount);

      const burnAmount = ethers.parseUnits("30", 6);
      await expect(token.burn(signers.alice.address, burnAmount))
        .to.emit(token, "Transfer")
        .withArgs(signers.alice.address, ethers.ZeroAddress, burnAmount);
    });
  });

  describe("Encrypted Operations", function () {
    it("should mint encrypted tokens with encrypted input", async function () {
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

      // Check encrypted balance exists (non-zero handle)
      const encBalance = await token.encBalances(signers.alice.address);
      expect(encBalance).to.not.equal(ethers.ZeroHash);

      // Public balance should remain 0
      expect(await token.balanceOf(signers.alice.address)).to.equal(0);
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

      const balanceBeforeBurn = await token.encBalances(signers.alice.address);

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

      const balanceAfterBurn = await token.encBalances(signers.alice.address);

      // Balance should have changed
      expect(balanceAfterBurn).to.not.equal(balanceBeforeBurn);
      expect(balanceAfterBurn).to.not.equal(ethers.ZeroHash);
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