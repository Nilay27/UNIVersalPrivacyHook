// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {euint128} from "@fhevm/solidity/lib/FHE.sol";
import {DoubleEndedQueue} from "@openzeppelin/contracts/utils/structs/DoubleEndedQueue.sol";

contract Queue {

    DoubleEndedQueue.Bytes32Deque private queue;

    function push(euint128 handle) external {
        DoubleEndedQueue.pushBack(queue, euintToBytes32(handle));
    }

    function pop() external returns(euint128) {
        return bytes32ToEuint(DoubleEndedQueue.popFront(queue));
    }

    function peek() external view returns(euint128) {
        return bytes32ToEuint(DoubleEndedQueue.front(queue));
    }

    function length() external view returns(uint256) {
        return DoubleEndedQueue.length(queue);
    }

    function isEmpty() external view returns(bool) {
        return DoubleEndedQueue.empty(queue);
    }

    function euintToBytes32(euint128 input) private pure returns(bytes32){
        return bytes32(euint128.unwrap(input));
    }

    function bytes32ToEuint(bytes32 input) private pure returns(euint128){
        return euint128.wrap(input);
    }
}
