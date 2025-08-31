import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { Queue, Queue__factory } from "../types";
import { expect } from "chai";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = (await ethers.getContractFactory("Queue")) as Queue__factory;
  const queue = (await factory.deploy()) as Queue;
  const queueAddress = await queue.getAddress();

  return { queue, queueAddress };
}

describe("Queue", function () {
  let signers: Signers;
  let queue: Queue;
  let queueAddress: string;

  before(async function () {
    const ethSigners: HardhatEthersSigner[] = await ethers.getSigners();
    signers = { deployer: ethSigners[0], alice: ethSigners[1] };
  });

  beforeEach(async function () {
    // Check whether the tests are running against an FHEVM mock environment
    if (!fhevm.isMock) {
      console.warn(`This hardhat test suite cannot run on Sepolia Testnet`);
      this.skip();
    }

    ({ queue, queueAddress } = await deployFixture());
  });

  describe("Basic Queue Operations", function () {
    it("should start with empty queue", async function () {
      expect(await queue.isEmpty()).to.be.true;
      expect(await queue.length()).to.equal(0);
    });

    it("should push and pop single element", async function () {
      // Create an encrypted value to push
      const value = 42n;
      const encryptedValue = await fhevm
        .createEncryptedInput(queueAddress, signers.alice.address)
        .add128(value)
        .encrypt();
      
      // Push to queue (convert to bytes32)
      const handle = ethers.hexlify(encryptedValue.handles[0]);
      await queue.push(handle);
      
      // Check queue state
      expect(await queue.isEmpty()).to.be.false;
      expect(await queue.length()).to.equal(1);
      
      // Pop from queue
      const poppedValue = await queue.pop.staticCall();
      expect(poppedValue).to.equal(handle);
      
      // Actually pop
      await queue.pop();
      expect(await queue.isEmpty()).to.be.true;
      expect(await queue.length()).to.equal(0);
    });

    it("should push multiple elements and pop in FIFO order", async function () {
      const values = [10n, 20n, 30n];
      const encryptedValues = [];
      
      // Push multiple values
      for (const value of values) {
        const encrypted = await fhevm
          .createEncryptedInput(queueAddress, signers.alice.address)
          .add128(value)
          .encrypt();
        const handle = ethers.hexlify(encrypted.handles[0]);
        encryptedValues.push(handle);
        await queue.push(handle);
      }
      
      expect(await queue.length()).to.equal(3);
      
      // Pop and verify FIFO order
      for (let i = 0; i < values.length; i++) {
        const poppedValue = await queue.pop.staticCall();
        expect(poppedValue).to.equal(encryptedValues[i]);
        await queue.pop();
      }
      
      expect(await queue.isEmpty()).to.be.true;
    });

    it("should peek without removing element", async function () {
      const value = 100n;
      const encryptedValue = await fhevm
        .createEncryptedInput(queueAddress, signers.alice.address)
        .add128(value)
        .encrypt();
      
      // Push value
      const handle = ethers.hexlify(encryptedValue.handles[0]);
      await queue.push(handle);
      
      // Peek should return same value multiple times
      const peeked1 = await queue.peek();
      const peeked2 = await queue.peek();
      expect(peeked1).to.equal(handle);
      expect(peeked2).to.equal(handle);
      
      // Queue should still have the element
      expect(await queue.length()).to.equal(1);
      expect(await queue.isEmpty()).to.be.false;
    });

    it("should handle push and pop operations correctly", async function () {
      const values = [5n, 10n, 15n, 20n];
      const encryptedValues = [];
      
      // Push first two values
      for (let i = 0; i < 2; i++) {
        const encrypted = await fhevm
          .createEncryptedInput(queueAddress, signers.alice.address)
          .add128(values[i])
          .encrypt();
        const handle = ethers.hexlify(encrypted.handles[0]);
        encryptedValues.push(handle);
        await queue.push(handle);
      }
      
      // Pop one
      await queue.pop();
      
      // Push remaining values
      for (let i = 2; i < values.length; i++) {
        const encrypted = await fhevm
          .createEncryptedInput(queueAddress, signers.alice.address)
          .add128(values[i])
          .encrypt();
        const handle = ethers.hexlify(encrypted.handles[0]);
        encryptedValues.push(handle);
        await queue.push(handle);
      }
      
      // Should have 3 elements now (2 - 1 + 2)
      expect(await queue.length()).to.equal(3);
      
      // Pop all and verify order
      const poppedValue1 = await queue.pop.staticCall();
      expect(poppedValue1).to.equal(encryptedValues[1]); // Second element (first was popped)
      await queue.pop();
      
      const poppedValue2 = await queue.pop.staticCall();
      expect(poppedValue2).to.equal(encryptedValues[2]);
      await queue.pop();
      
      const poppedValue3 = await queue.pop.staticCall();
      expect(poppedValue3).to.equal(encryptedValues[3]);
      await queue.pop();
      
      expect(await queue.isEmpty()).to.be.true;
    });
  });

  describe("Edge Cases", function () {
    it("should revert when popping from empty queue", async function () {
      expect(await queue.isEmpty()).to.be.true;
      await expect(queue.pop()).to.be.reverted;
    });

    it("should revert when peeking empty queue", async function () {
      expect(await queue.isEmpty()).to.be.true;
      await expect(queue.peek()).to.be.reverted;
    });

    it("should handle bytes32(0) as valid element", async function () {
      const zeroValue = ethers.ZeroHash;
      
      await queue.push(zeroValue);
      expect(await queue.isEmpty()).to.be.false;
      expect(await queue.length()).to.equal(1);
      
      const peeked = await queue.peek();
      expect(peeked).to.equal(zeroValue);
      
      const popped = await queue.pop.staticCall();
      expect(popped).to.equal(zeroValue);
    });
  });
});