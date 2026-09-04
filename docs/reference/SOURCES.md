# Event layout sources

Verified 2026-09-04 against the protocols' own interface source. Only the declarations are quoted here; the files themselves carry their own licences and are not vendored.

## Aave v3 (also Spark, an Aave v3 fork with identical topic0s)

aave-dao/aave-v3-origin @ `cff15de6d1271b0c800fc001f4aea4c263e8a597`, `src/contracts/interfaces/IPool.sol`

```solidity
  event Borrow(
    address indexed reserve,
    address user,
    address indexed onBehalfOf,
    uint256 amount,
    DataTypes.InterestRateMode interestRateMode,
    uint256 borrowRate,
    uint16 indexed referralCode
  );
  event Repay(
    address indexed reserve,
    address indexed user,
    address indexed repayer,
    uint256 amount,
    bool useATokens
  );
  event LiquidationCall(
    address indexed collateralAsset,
    address indexed debtAsset,
    address indexed user,
    uint256 debtToCover,
    uint256 liquidatedCollateralAmount,
    address liquidator,
    bool receiveAToken
  );
```

## Morpho Blue

morpho-org/morpho-blue @ `c3f327e49ddae623e2e3162f8468d58fbb79d1b8`, `src/libraries/EventsLib.sol`

```solidity
    event Borrow(
        Id indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
    event Repay(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Liquidate(
        Id indexed id,
        address indexed caller,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedAssets,
        uint256 badDebtAssets,
        uint256 badDebtShares
    );
```

## topic0 (keccak256 of the canonical signature)

| event | topic0 |
|---|---|
| Aave/Spark Borrow | 0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0 |
| Aave/Spark Repay | 0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051 |
| Aave/Spark LiquidationCall | 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286 |
| Morpho Borrow | 0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43 |
| Morpho Repay | 0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09 |
| Morpho Liquidate | 0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41 |

Indexed positions (topics[1..3]) and data-field order follow directly from the declarations above.
