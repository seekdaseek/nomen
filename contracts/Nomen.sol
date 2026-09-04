// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @title Nomen — portable, proven credit history.
/// @notice Every record here exists because the Creditcoin native query verifier (0xFD2) proved that the
///         Ethereum mainnet transaction which produced it was included in an attested block. The receipt's
///         logs are decoded on-chain; only logs emitted by the Aave v3 Pool, Morpho Blue or the Spark Pool
///         count. No oracle, no indexer, no self-report, no owner, no admin, no way to edit a record.
/// @dev    `record()` is `ASCBase.execute()` with two additions the base hook cannot provide: it rejects any
///         source chain other than Ethereum mainnet (chainKey 3) and it passes the proven block height into
///         the record. It reuses ASCBase's `_computeQueryId`, `_verifyProof` and `processedQueries` verbatim.
///         The inherited `execute()` therefore reverts with `UseRecord()` so it cannot bypass the chain check.
contract Nomen is ASCBase {
    enum Kind {
        Borrow, // 0
        Repay, // 1
        Liquidation // 2
    }

    enum Protocol {
        AaveV3, // 0
        MorphoBlue, // 1
        Spark // 2
    }

    /// @notice Ethereum mainnet's chain key on Creditcoin CC3 testnet (chainKey 1 is Sepolia).
    uint64 public constant SOURCE_CHAIN_KEY = 3;

    address public constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address public constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant SPARK_POOL = 0xC13e21B648A5Ee794902342038FF3aDAB66BE987;

    // keccak256 of the canonical signatures; see docs/reference/SOURCES.md.
    bytes32 public constant AAVE_BORROW = 0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0;
    bytes32 public constant AAVE_REPAY = 0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051;
    bytes32 public constant AAVE_LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    bytes32 public constant MORPHO_BORROW = 0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43;
    bytes32 public constant MORPHO_REPAY = 0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09;
    bytes32 public constant MORPHO_LIQUIDATE = 0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41;

    /// @notice ChainInfo precompile; `get_latest_attestation_height_and_hash(uint64)` gives the attested Ethereum head.
    address internal constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    /// @notice A liquidation's score penalty decays linearly to zero over this many Ethereum blocks (~1 year at 12 s).
    uint256 public constant LIQUIDATION_DECAY_BLOCKS = 2_628_000;

    struct Record {
        uint32 borrows;
        uint32 repays;
        uint32 liquidations;
        uint128 borrowed; // raw token units, summed across assets; USD is an off-chain figure
        uint128 repaid;
        uint128 liquidated; // debt repaid by liquidators (Aave debtToCover / Morpho repaidAssets)
        uint64 firstEthBlock;
        uint64 lastEthBlock;
        uint64 lastLiquidationBlock;
    }

    mapping(address => Record) internal _records;

    uint64 public totalEvents;
    uint64 public borrowers;
    uint64[3] internal _byKind;
    uint64[3] internal _byProtocol;

    event CreditEvent(
        address indexed borrower,
        uint8 kind,
        uint8 protocol,
        bytes32 marketOrAsset, // Aave/Spark: reserve or debt asset address; Morpho: market Id
        uint256 amount,
        uint64 ethBlock,
        bytes32 queryId
    );

    error WrongChain(uint64 chainKey);
    error InvalidKind(uint8 kind);
    error UseRecord();
    error UnsupportedTransactionType(uint8 txType);
    error TransactionFailed();
    error NoCreditEvent();
    error AmountTooLarge(uint256 amount);

    /// @notice Prove an Ethereum mainnet transaction and record every credit event in its receipt.
    /// @param kind The Kind the submitter asserts is present; reverts with NoCreditEvent if none of that kind
    ///             is found. All credit events of every kind in the receipt are recorded, since the receipt is
    ///             proven once and the queryId can never be submitted again.
    function record(
        uint8 kind,
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (bool success) {
        if (chainKey != SOURCE_CHAIN_KEY) revert WrongChain(chainKey);
        if (kind > uint8(Kind.Liquidation)) revert InvalidKind(kind);

        bytes32 queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
        require(!processedQueries[queryId], "Query already processed");

        bool verified = _verifyProof(
            chainKey, blockHeight, encodedTransaction, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );
        require(verified, "Proof of inclusion verification failed");

        processedQueries[queryId] = true;

        _recordCreditEvents(Kind(kind), queryId, blockHeight, encodedTransaction);
        return true;
    }

    /// @dev The base entrypoint cannot enforce the source chain; all submissions go through `record`.
    function _processAndEmitEvent(uint8, bytes32, bytes memory) internal pure override {
        revert UseRecord();
    }

    // ---------------------------------------------------------------- views

    function history(address borrower) external view returns (Record memory) {
        return _records[borrower];
    }

    function totals()
        external
        view
        returns (uint64 events, uint64[3] memory byKind, uint64[3] memory byProtocol, uint64 borrowersScored)
    {
        return (totalEvents, _byKind, _byProtocol, borrowers);
    }

    /// @notice Deterministic score from the proven record. Not a credit model; a demonstration that one can be
    ///         computed on-chain from proven inputs. Formula:
    ///         no history -> (0, 'N');
    ///         base 500; + min(200, repays * 10); + 50 if borrows > 0 and liquidations == 0;
    ///         - 150 per liquidation, decaying linearly to 0 over LIQUIDATION_DECAY_BLOCKS since the last one,
    ///           measured against the attested Ethereum head (falls back to the borrower's last proven block);
    ///         clamp 0..1000. Grade: A >= 700, B >= 600, C >= 500, D >= 350, else E.
    function score(address borrower) public view returns (uint16 value, uint8 grade) {
        Record memory r = _records[borrower];
        if (r.borrows == 0 && r.repays == 0 && r.liquidations == 0) return (0, uint8(bytes1("N")));

        int256 v = 500;
        uint256 bonus = uint256(r.repays) * 10;
        if (bonus > 200) bonus = 200;
        v += int256(bonus);
        if (r.borrows > 0 && r.liquidations == 0) v += 50;

        if (r.liquidations > 0) {
            (uint64 head, bool ok) = attestedEthHead();
            uint256 nowBlock = (ok && head > r.lastEthBlock) ? head : r.lastEthBlock;
            uint256 since = nowBlock > r.lastLiquidationBlock ? nowBlock - r.lastLiquidationBlock : 0;
            uint256 remaining = since >= LIQUIDATION_DECAY_BLOCKS ? 0 : LIQUIDATION_DECAY_BLOCKS - since;
            v -= int256((uint256(r.liquidations) * 150 * remaining) / LIQUIDATION_DECAY_BLOCKS);
        }

        if (v < 0) v = 0;
        if (v > 1000) v = 1000;
        value = uint16(uint256(v));
        if (value >= 700) grade = uint8(bytes1("A"));
        else if (value >= 600) grade = uint8(bytes1("B"));
        else if (value >= 500) grade = uint8(bytes1("C"));
        else if (value >= 350) grade = uint8(bytes1("D"));
        else grade = uint8(bytes1("E"));
    }

    /// @notice Latest attested Ethereum mainnet height from the ChainInfo precompile; ok=false off-chain / in tests.
    function attestedEthHead() public view returns (uint64 height, bool ok) {
        (bool success, bytes memory ret) = CHAIN_INFO.staticcall(
            abi.encodeWithSignature("get_latest_attestation_height_and_hash(uint64)", SOURCE_CHAIN_KEY)
        );
        if (!success || ret.length < 128) return (0, false);
        (uint64 h,,, bool exists) = abi.decode(ret, (uint64, bytes32, bool, bool));
        return (h, exists);
    }

    // ------------------------------------------------------------- internals

    function _recordCreditEvents(Kind kind, bytes32 queryId, uint64 ethBlock, bytes memory encodedTransaction)
        internal
    {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert UnsupportedTransactionType(txType);

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailed();

        EvmV1Decoder.LogEntry[] memory logs = receipt.receiptLogs;
        uint256 matched;
        for (uint256 i; i < logs.length; ++i) {
            EvmV1Decoder.LogEntry memory log = logs[i];
            (bool isPool, Protocol protocol) = _protocolOf(log.address_);
            if (!isPool || log.topics.length != 4) continue;

            (bool isCredit, Kind k, address borrower, bytes32 marketOrAsset, uint256 amount) = _decode(protocol, log);
            if (!isCredit || amount == 0) continue; // never record a zero

            if (k == kind) ++matched;
            _apply(borrower, k, protocol, marketOrAsset, amount, ethBlock, queryId);
        }
        if (matched == 0) revert NoCreditEvent();
    }

    function _protocolOf(address emitter) internal pure returns (bool isPool, Protocol protocol) {
        if (emitter == AAVE_V3_POOL) return (true, Protocol.AaveV3);
        if (emitter == MORPHO_BLUE) return (true, Protocol.MorphoBlue);
        if (emitter == SPARK_POOL) return (true, Protocol.Spark);
        return (false, Protocol.AaveV3);
    }

    /// @dev Layouts verified against aave-v3-origin IPool.sol and morpho-blue EventsLib.sol (docs/reference/SOURCES.md).
    ///      Every branch checks the exact data length so a layout mismatch is a skip, never a misread.
    function _decode(Protocol protocol, EvmV1Decoder.LogEntry memory log)
        internal
        pure
        returns (bool ok, Kind kind, address borrower, bytes32 marketOrAsset, uint256 amount)
    {
        bytes32 t0 = log.topics[0];
        bytes memory d = log.data;
        if (protocol == Protocol.MorphoBlue) {
            if (t0 == MORPHO_BORROW && d.length == 96) {
                // Borrow(Id indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)
                return (true, Kind.Borrow, _addr(log.topics[2]), log.topics[1], _word(d, 1));
            }
            if (t0 == MORPHO_REPAY && d.length == 64) {
                // Repay(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)
                return (true, Kind.Repay, _addr(log.topics[3]), log.topics[1], _word(d, 0));
            }
            if (t0 == MORPHO_LIQUIDATE && d.length == 160) {
                // Liquidate(Id indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, ...)
                return (true, Kind.Liquidation, _addr(log.topics[3]), log.topics[1], _word(d, 0));
            }
        } else {
            if (t0 == AAVE_BORROW && d.length == 128) {
                // Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 mode, uint256 rate, uint16 indexed ref)
                return (true, Kind.Borrow, _addr(log.topics[2]), log.topics[1], _word(d, 1));
            }
            if (t0 == AAVE_REPAY && d.length == 64) {
                // Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
                return (true, Kind.Repay, _addr(log.topics[2]), log.topics[1], _word(d, 0));
            }
            if (t0 == AAVE_LIQUIDATION_CALL && d.length == 128) {
                // LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, ...)
                return (true, Kind.Liquidation, _addr(log.topics[3]), log.topics[2], _word(d, 0));
            }
        }
        return (false, Kind.Borrow, address(0), bytes32(0), 0);
    }

    function _apply(
        address borrower,
        Kind k,
        Protocol p,
        bytes32 marketOrAsset,
        uint256 amount,
        uint64 ethBlock,
        bytes32 queryId
    ) internal {
        if (amount > type(uint128).max) revert AmountTooLarge(amount);
        Record storage r = _records[borrower];

        if (r.firstEthBlock == 0) {
            r.firstEthBlock = ethBlock;
            ++borrowers;
        } else if (ethBlock < r.firstEthBlock) {
            r.firstEthBlock = ethBlock;
        }
        if (ethBlock > r.lastEthBlock) r.lastEthBlock = ethBlock;

        if (k == Kind.Borrow) {
            ++r.borrows;
            r.borrowed += uint128(amount);
        } else if (k == Kind.Repay) {
            ++r.repays;
            r.repaid += uint128(amount);
        } else {
            ++r.liquidations;
            r.liquidated += uint128(amount);
            if (ethBlock > r.lastLiquidationBlock) r.lastLiquidationBlock = ethBlock;
        }

        ++totalEvents;
        ++_byKind[uint8(k)];
        ++_byProtocol[uint8(p)];

        emit CreditEvent(borrower, uint8(k), uint8(p), marketOrAsset, amount, ethBlock, queryId);
    }

    function _addr(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    function _word(bytes memory d, uint256 i) internal pure returns (uint256 w) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            w := mload(add(d, add(32, mul(i, 32))))
        }
    }
}
