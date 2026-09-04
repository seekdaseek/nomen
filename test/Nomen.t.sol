// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Nomen} from "../contracts/Nomen.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {MockNativeQueryVerifier, MockChainInfo} from "./mocks/MockNativeQueryVerifier.sol";

/// @notice Tests run against REAL prover responses captured from Ethereum mainnet (test/fixtures/*.json) with the
///         inclusion verifier mocked, plus synthetic receipts for the rejection paths.
contract NomenTest is Test {
    address internal constant VERIFIER = 0x0000000000000000000000000000000000000FD2;
    address internal constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    Nomen internal nomen;
    string internal expected;

    struct Proof {
        uint64 height;
        bytes txBytes;
        bytes32 root;
        INativeQueryVerifier.MerkleProofEntry[] siblings;
        bytes32 lower;
        bytes32[] roots;
        uint64 txIndex;
    }

    function setUp() public {
        vm.etch(VERIFIER, address(new MockNativeQueryVerifier()).code);
        nomen = new Nomen();
        expected = vm.readFile("test/fixtures/expected.json");
    }

    // ------------------------------------------------------------ fixtures

    function _load(string memory name) internal view returns (Proof memory p) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name, ".json"));
        p.height = uint64(vm.parseJsonUint(json, ".headerNumber"));
        p.txBytes = vm.parseJsonBytes(json, ".txBytes");
        p.root = vm.parseJsonBytes32(json, ".merkleProof.root");
        p.siblings = abi.decode(vm.parseJson(json, ".merkleProof.siblings"), (INativeQueryVerifier.MerkleProofEntry[]));
        p.lower = vm.parseJsonBytes32(json, ".continuityProof.lowerEndpointDigest");
        p.roots = vm.parseJsonBytes32Array(json, ".continuityProof.roots");
        p.txIndex = uint64(vm.parseJsonUint(json, ".txIndex"));
    }

    function _record(uint8 kind, Proof memory p) internal returns (bool) {
        return nomen.record(kind, 3, p.height, p.txBytes, p.root, p.siblings, p.lower, p.roots);
    }

    function _exp(string memory name, string memory field) internal pure returns (string memory) {
        return string.concat(".", name, ".creditEvents[0].", field);
    }

    function _kindOf(string memory k) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(k));
        if (h == keccak256("Borrow")) return 0;
        if (h == keccak256("Repay")) return 1;
        return 2;
    }

    function _protocolOf(string memory p) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(p));
        if (h == keccak256("AaveV3")) return 0;
        if (h == keccak256("MorphoBlue")) return 1;
        return 2;
    }

    /// @dev Records a real fixture and checks the decoded borrower / amount / market against the receipt
    ///      as read independently off-chain (expected.json).
    function _checkFixture(string memory name) internal {
        Proof memory p = _load(name);
        address borrower = vm.parseJsonAddress(expected, _exp(name, "borrower"));
        uint256 amount = vm.parseJsonUint(expected, _exp(name, "amount"));
        bytes32 market = vm.parseJsonBytes32(expected, _exp(name, "marketOrAsset"));
        uint8 kind = _kindOf(vm.parseJsonString(expected, _exp(name, "kind")));
        uint8 protocol = _protocolOf(vm.parseJsonString(expected, _exp(name, "protocol")));

        vm.expectEmit(true, false, false, false, address(nomen));
        emit Nomen.CreditEvent(borrower, kind, protocol, market, amount, p.height, bytes32(0));
        assertTrue(_record(kind, p));

        Nomen.Record memory r = nomen.history(borrower);
        if (kind == 0) {
            assertEq(r.borrows, 1, "borrows");
            assertEq(r.borrowed, amount, "borrowed");
        } else if (kind == 1) {
            assertEq(r.repays, 1, "repays");
            assertEq(r.repaid, amount, "repaid");
        } else {
            assertEq(r.liquidations, 1, "liquidations");
            assertEq(r.liquidated, amount, "liquidated");
            assertEq(r.lastLiquidationBlock, p.height, "lastLiquidationBlock");
        }
        assertEq(r.firstEthBlock, p.height, "firstEthBlock");
        assertEq(r.lastEthBlock, p.height, "lastEthBlock");
        (uint64 events,,,) = nomen.totals();
        assertGe(events, 1);
    }

    // ---------------------------------------------------- real fixtures

    function test_AaveBorrow_decodesFromRealProof() public {
        _checkFixture("aave_borrow");
    }

    function test_MorphoRepay_decodesFromRealProof() public {
        _checkFixture("morpho_repay");
    }

    function test_AaveLiquidation_decodesFromRealProof() public {
        _checkFixture("aave_liquidation");
    }

    function test_SparkBorrow_decodesFromRealProof() public {
        _checkFixture("spark_borrow");
    }

    function test_MorphoBorrow_decodesFromRealProof() public {
        _checkFixture("morpho_borrow");
    }

    function test_MockTxIndexMatchesProverTxIndex() public view {
        Proof memory p = _load("aave_borrow");
        INativeQueryVerifier.MerkleProof memory mp = INativeQueryVerifier.MerkleProof(p.root, p.siblings);
        assertEq(INativeQueryVerifier(VERIFIER).calculateTxIndex(mp), p.txIndex);
    }

    function test_Totals_countAcrossFixtures() public {
        _record(0, _load("aave_borrow"));
        _record(1, _load("morpho_repay"));
        _record(2, _load("aave_liquidation"));
        (uint64 events, uint64[3] memory byKind, uint64[3] memory byProtocol, uint64 borrowers) = nomen.totals();
        assertGe(events, 3);
        assertGe(byKind[0], 1);
        assertGe(byKind[1], 1);
        assertGe(byKind[2], 1);
        assertGe(byProtocol[0], 2);
        assertGe(byProtocol[1], 1);
        assertGe(borrowers, 2);
    }

    // ------------------------------------------------------- rejections

    function test_Replay_rejectedByQueryId() public {
        Proof memory p = _load("aave_borrow");
        _record(0, p);
        vm.expectRevert("Query already processed");
        _record(0, p);
    }

    function test_WrongChainKey_rejected() public {
        Proof memory p = _load("aave_borrow");
        vm.expectRevert(abi.encodeWithSelector(Nomen.WrongChain.selector, uint64(1)));
        nomen.record(0, 1, p.height, p.txBytes, p.root, p.siblings, p.lower, p.roots);
    }

    function test_InvalidKind_rejected() public {
        Proof memory p = _load("aave_borrow");
        vm.expectRevert(abi.encodeWithSelector(Nomen.InvalidKind.selector, uint8(3)));
        _record(3, p);
    }

    function test_WrongKind_isNoCreditEvent() public {
        Proof memory p = _load("aave_borrow");
        vm.expectRevert(Nomen.NoCreditEvent.selector);
        _record(2, p); // a Borrow tx submitted as a Liquidation
    }

    function test_VerifierFalse_rejected() public {
        MockNativeQueryVerifier(VERIFIER).setFail(true);
        Proof memory p = _load("aave_borrow");
        vm.expectRevert("Proof of inclusion verification failed");
        _record(0, p);
    }

    function test_ExecuteEntrypoint_revertsUseRecord() public {
        Proof memory p = _load("aave_borrow");
        vm.expectRevert(Nomen.UseRecord.selector);
        nomen.execute(0, 3, p.height, p.txBytes, p.root, p.siblings, p.lower, p.roots);
    }

    function test_WrongEmitter_rejected() public {
        bytes memory tx_ = _syntheticAaveBorrow(address(0xBAD), address(0xB0B), 1e18, 1);
        vm.expectRevert(Nomen.NoCreditEvent.selector);
        _recordSynthetic(0, 100, tx_);
    }

    function test_FailedReceipt_rejected() public {
        bytes memory tx_ = _syntheticAaveBorrow(nomen.AAVE_V3_POOL(), address(0xB0B), 1e18, 0);
        vm.expectRevert(Nomen.TransactionFailed.selector);
        _recordSynthetic(0, 101, tx_);
    }

    function test_UnrelatedTx_isNoCreditEvent() public {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(1));
        topics[2] = bytes32(uint256(2));
        bytes memory tx_ = _synthetic(address(0xCAFE), topics, abi.encode(uint256(5)), 1);
        vm.expectRevert(Nomen.NoCreditEvent.selector);
        _recordSynthetic(0, 102, tx_);
    }

    function test_ZeroAmount_neverRecorded() public {
        bytes memory tx_ = _syntheticAaveBorrow(nomen.AAVE_V3_POOL(), address(0xB0B), 0, 1);
        vm.expectRevert(Nomen.NoCreditEvent.selector);
        _recordSynthetic(0, 103, tx_);
    }

    function test_SparkEmitter_recordedAsSpark() public {
        bytes memory tx_ = _syntheticAaveBorrow(nomen.SPARK_POOL(), address(0xB0B), 7e6, 1);
        vm.expectEmit(true, false, false, true, address(nomen));
        emit Nomen.CreditEvent(address(0xB0B), 0, 2, bytes32(uint256(uint160(address(0xA55E7)))), 7e6, 104, _syntheticQueryId(104));
        _recordSynthetic(0, 104, tx_);
        (, , uint64[3] memory byProtocol,) = nomen.totals();
        assertEq(byProtocol[2], 1);
    }

    function test_MultipleEventsInOneTx_allRecorded() public {
        // one receipt with an Aave Borrow and an Aave Repay for the same borrower, submitted as Borrow
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _aaveBorrowLog(nomen.AAVE_V3_POOL(), address(0xB0B), 3e18);
        bytes32[] memory rt = new bytes32[](4);
        rt[0] = nomen.AAVE_REPAY();
        rt[1] = bytes32(uint256(uint160(address(0xA55E7))));
        rt[2] = bytes32(uint256(uint160(address(0xB0B))));
        rt[3] = bytes32(uint256(uint160(address(0xB0B))));
        logs[1] = EvmV1Decoder.LogEntryTuple(nomen.AAVE_V3_POOL(), rt, abi.encode(uint256(2e18), false));
        bytes memory tx_ = _encode(logs, 1);
        _recordSynthetic(0, 105, tx_);
        Nomen.Record memory r = nomen.history(address(0xB0B));
        assertEq(r.borrows, 1);
        assertEq(r.repays, 1);
        assertEq(r.borrowed, 3e18);
        assertEq(r.repaid, 2e18);
        (uint64 events,,,) = nomen.totals();
        assertEq(events, 2);
    }

    // ------------------------------------------------------------- score

    function test_Score_noHistory() public view {
        (uint16 v, uint8 g) = nomen.score(address(0xDEAD));
        assertEq(v, 0);
        assertEq(g, uint8(bytes1("N")));
    }

    function test_Score_borrowerWithoutLiquidation() public {
        string memory name = "aave_borrow";
        address borrower = vm.parseJsonAddress(expected, _exp(name, "borrower"));
        _record(0, _load(name));
        (uint16 v, uint8 g) = nomen.score(borrower);
        assertEq(v, 550); // 500 + 50 (borrows > 0, no liquidation)
        assertEq(g, uint8(bytes1("C")));
    }

    function test_Score_freshLiquidation_fullPenalty() public {
        string memory name = "aave_liquidation";
        address borrower = vm.parseJsonAddress(expected, _exp(name, "borrower"));
        _record(2, _load(name));
        Nomen.Record memory r = nomen.history(borrower);
        // no ChainInfo precompile here: "now" falls back to the borrower's last proven block => zero decay
        (uint16 v, uint8 g) = nomen.score(borrower);
        uint256 want = 500 - 150 * r.liquidations + (r.repays * 10 > 200 ? 200 : r.repays * 10);
        assertEq(v, uint16(want));
        assertEq(g, want >= 350 ? uint8(bytes1("D")) : uint8(bytes1("E")));
    }

    function test_Score_liquidationDecaysAgainstAttestedHead() public {
        string memory name = "aave_liquidation";
        address borrower = vm.parseJsonAddress(expected, _exp(name, "borrower"));
        Proof memory p = _load(name);
        _record(2, p);
        Nomen.Record memory r = nomen.history(borrower);
        uint256 base = 500 + (r.repays * 10 > 200 ? 200 : r.repays * 10);

        vm.etch(CHAIN_INFO, address(new MockChainInfo()).code);
        (uint64 head, bool ok) = nomen.attestedEthHead();
        assertTrue(ok);
        assertEq(head, 0);

        MockChainInfo(CHAIN_INFO).setHead(uint64(p.height + nomen.LIQUIDATION_DECAY_BLOCKS() / 2));
        (uint16 half,) = nomen.score(borrower);
        assertEq(half, uint16(base - 75 * r.liquidations));

        MockChainInfo(CHAIN_INFO).setHead(uint64(p.height + nomen.LIQUIDATION_DECAY_BLOCKS() + 1));
        (uint16 gone, uint8 g) = nomen.score(borrower);
        assertEq(gone, uint16(base)); // penalty fully decayed; no +50 because liquidations != 0
        assertEq(g, base >= 600 ? uint8(bytes1("B")) : uint8(bytes1("C")));
    }

    function test_Score_repayBonusCapsAt200() public {
        // 25 synthetic repays for one borrower, each its own proven tx
        for (uint64 i; i < 25; ++i) {
            bytes32[] memory rt = new bytes32[](4);
            rt[0] = nomen.AAVE_REPAY();
            rt[1] = bytes32(uint256(uint160(address(0xA55E7))));
            rt[2] = bytes32(uint256(uint160(address(0xB0B))));
            rt[3] = bytes32(uint256(uint160(address(0xB0B))));
            EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
            logs[0] = EvmV1Decoder.LogEntryTuple(nomen.AAVE_V3_POOL(), rt, abi.encode(uint256(1e18), false));
            _recordSynthetic(1, 1000 + i, _encode(logs, 1));
        }
        (uint16 v, uint8 g) = nomen.score(address(0xB0B));
        assertEq(v, 700); // 500 + 200; no borrow => no +50
        assertEq(g, uint8(bytes1("A")));
    }

    // --------------------------------------------------------- synthetic

    function _syntheticQueryId(uint64 height) internal pure returns (bytes32 queryId) {
        // mirrors ASCBase._computeQueryId with the mock's txIndex for zero siblings (0)
        uint64 chainKey = 3;
        uint256 txIndex = 0;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainKey)
            mstore(add(ptr, 32), shl(192, height))
            mstore(add(ptr, 40), txIndex)
            queryId := keccak256(ptr, 72)
        }
    }

    function _recordSynthetic(uint8 kind, uint64 height, bytes memory tx_) internal returns (bool) {
        INativeQueryVerifier.MerkleProofEntry[] memory none = new INativeQueryVerifier.MerkleProofEntry[](0);
        return nomen.record(kind, 3, height, tx_, bytes32(uint256(height)), none, bytes32(0), new bytes32[](0));
    }

    function _aaveBorrowLog(address emitter, address onBehalfOf, uint256 amount)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = 0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0;
        topics[1] = bytes32(uint256(uint160(address(0xA55E7)))); // reserve
        topics[2] = bytes32(uint256(uint160(onBehalfOf)));
        topics[3] = bytes32(0); // referralCode
        bytes memory data = abi.encode(address(0xCA11E7), amount, uint8(2), uint256(0));
        return EvmV1Decoder.LogEntryTuple(emitter, topics, data);
    }

    function _syntheticAaveBorrow(address emitter, address onBehalfOf, uint256 amount, uint8 status)
        internal
        pure
        returns (bytes memory)
    {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = _aaveBorrowLog(emitter, onBehalfOf, amount);
        return _encode(logs, status);
    }

    function _synthetic(address emitter, bytes32[] memory topics, bytes memory data, uint8 status)
        internal
        pure
        returns (bytes memory)
    {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple(emitter, topics, data);
        return _encode(logs, status);
    }

    /// @dev Same chunk layout the prover uses for a type-0 tx: (uint8 txType, bytes[3] chunks).
    function _encode(EvmV1Decoder.LogEntryTuple[] memory logs, uint8 status) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = abi.encode(uint64(0), uint64(21_000), address(0x1), false, address(0x2), uint256(0), bytes(""));
        chunks[1] = abi.encode(uint128(1), uint256(27), bytes32(0), bytes32(0));
        chunks[2] = abi.encode(status, uint64(21_000), logs, bytes(""));
        return abi.encode(uint8(0), chunks);
    }
}
