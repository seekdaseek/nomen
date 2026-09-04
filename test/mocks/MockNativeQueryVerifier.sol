// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev Stand-in for the native query verifier precompile (0xFD2), etched there in tests.
///      txIndex is derived from the sibling path: a sibling on the left means our node is on the right (bit set).
contract MockNativeQueryVerifier {
    bool public fail;

    function setFail(bool f) external {
        fail = f;
    }

    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata proof) external pure returns (uint64 idx) {
        for (uint256 i; i < proof.siblings.length; ++i) {
            if (proof.siblings[i].isLeft) idx |= uint64(1) << uint64(i);
        }
    }

    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external view returns (bool) {
        return !fail;
    }
}

/// @dev Stand-in for the ChainInfo precompile (0xFD3): returns a chosen attested Ethereum head.
contract MockChainInfo {
    uint64 public head;

    function setHead(uint64 h) external {
        head = h;
    }

    function get_latest_attestation_height_and_hash(uint64)
        external
        view
        returns (uint64 height, bytes32 hash, bool isAttestation, bool exists)
    {
        return (head, bytes32(uint256(head)), true, true);
    }
}
