// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {SimpleBoringVault} from "./SimpleBoringVault.sol";

/**
 * @title BaseSwapManager
 * @notice Minimal swap manager for non-FHE environments (e.g., Base)
 * @dev Authorised operators forward pre-signed UEI payloads directly to the vault.
 */
contract BaseSwapManager {
    address public admin;
    address payable public boringVault;
    mapping(address => bool) public authorizedCallers;

    event AdminUpdated(address indexed newAdmin);
    event BoringVaultUpdated(address indexed vault);
    event CallerAuthorizationChanged(address indexed caller, bool authorized);
    event UEIExecuted(bytes32 indexed intentId, address indexed target, bool success, bytes result);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier onlyAuthorized() {
        require(authorizedCallers[msg.sender], "Not authorized");
        _;
    }

    constructor(address _admin, address payable _boringVault) {
        require(_admin != address(0), "Invalid admin");
        admin = _admin;
        boringVault = _boringVault;
        authorizedCallers[_admin] = true;
        emit AdminUpdated(_admin);
        if (_boringVault != address(0)) {
            emit BoringVaultUpdated(_boringVault);
        }
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid admin");
        admin = newAdmin;
        authorizedCallers[newAdmin] = true;
        emit AdminUpdated(newAdmin);
    }

    function setBoringVault(address payable vault) external onlyAdmin {
        require(vault != address(0), "Invalid vault");
        boringVault = vault;
        emit BoringVaultUpdated(vault);
    }

    function setCallerAuthorization(address caller, bool authorized) external onlyAdmin {
        authorizedCallers[caller] = authorized;
        emit CallerAuthorizationChanged(caller, authorized);
    }

    /**
     * @notice Executes a batch of pre-validated UEIs on the configured vault.
     * @dev Signature arguments are accepted for ABI compatibility but not validated.
     */
    function processUEI(
        bytes32[] calldata intentIds,
        address[] calldata,
        address[] calldata targets,
        bytes[] calldata calldatas,
        bytes[] calldata
    ) external onlyAuthorized {
        require(boringVault != address(0), "Vault not set");
        uint256 length = targets.length;
        require(intentIds.length == length && calldatas.length == length, "Length mismatch");

        for (uint256 i = 0; i < length; ++i) {
            (bool success, bytes memory result) = _execute(targets[i], calldatas[i]);
            emit UEIExecuted(intentIds[i], targets[i], success, result);
        }
    }

    function _execute(address target, bytes calldata data)
        internal
        returns (bool success, bytes memory result)
    {
        if (boringVault == address(0)) {
            return (false, "");
        }
        try SimpleBoringVault(boringVault).execute(target, data, 0) returns (bytes memory res) {
            return (true, res);
        } catch (bytes memory err) {
            return (false, err);
        }
    }
}

