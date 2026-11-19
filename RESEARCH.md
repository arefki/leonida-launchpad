# Ammora SDK — Phase 1 research (2026-11-19)

Research for the Ammora Season 2 Builder mission ("Ship an exchange or launchpad
with the Ammora SDK"). All findings below were verified live against GIWA Sepolia
(chain 91342) from this machine unless marked otherwise.

## Verdict: VIABLE

The SDK is a real, documented, browser-safe TypeScript package. A static
single-page launchpad that reads live launches/Configs, quotes trades, and builds
unsigned create/swap transactions for the user's own wallet is the smallest honest
qualifying build. No mock data is used anywhere in the app.

## The SDK

- Package: `@ammora-protocol/sdk` **v0.3.9** (MIT), ESM-only, 1,095 exports.
  Deps: `viem ^2.33.0`, `@ammora-protocol/math 0.3.0`. No `engines` field.
- Repo: https://github.com/ammora-labs/ammora-protocol (`packages/sdk`).
- Docs: https://docs.ammora.org (mirror https://ammora-docs.vercel.app),
  SDK quickstart https://docs.ammora.org/ai/sdk-quickstart.md,
  llms.txt https://docs.ammora.org/llms.txt, examples
  https://github.com/AmmoraLabs/ammora-examples (LAUNCHPAD.md).
- What it provides: bonding-curve launches (V4 ALC), concentrated/compounding
  AMMs (ARL), ALMM bin pools, genesis/yield vaults, presales, routers, token
  vesting (TokenLock), fee sharing/claims, NFT SDK (separate package).
- Status: **beta testnet software**. GIWA-qualified release live on GIWA Sepolia;
  no mainnet announced; **no independent security audit**. ABIs may change in 0.x.
- Browser-safe: `dist/index.js` contains zero `node:` imports, zero `require()`
  calls, zero `process.env` uses (verified by grep). The docs explicitly describe
  the browser pattern: sign through the connected user's WalletClient, keep CLI
  dotenv/fs/private-key loaders out of browser bundles.

## GIWA Sepolia deployment (auto-route, slot `v4-auto-route-20260917`)

From `giwaSepoliaAutoRouteDeployment` (verified live 2026-11-19, block ~41,744,xxx):

| Item | Address |
|---|---|
| Chain | 91342 — GIWA Sepolia, RPC https://sepolia-rpc.giwa.io, explorer https://sepolia-explorer.giwa.io |
| Launch factory | `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA` |
| Config registry | `0x6d043014972b87406C4757a5f2d655A24e0b0aF9` |
| Fee policy | `0x17B44C14F640fD429740FA3220f47a567c62725C` |
| First-buy executor | `0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451` |
| Math module | `0xbF5f52525E7415896bCa7f7cBADcEB294dF173ef` |
| Graduation adapter | `0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263` |
| Concentrated factory | `0x9eBD78f3839996014238728b4c9C2f2A4e6759Cb` |
| WETH (quote token) | `0x4200000000000000000000000000000000000006` |

## Live reads verified (Node + viem, public RPC)

- `getBlockNumber()` → ~41,744,496 at test time.
- `getAmmoraV4NextConfigId()` → **63** (Configs 1–62 exist).
- `getAmmoraV4ConfigAtBlock()` on Configs 60–62: quoteToken WETH, totalSupply
  1e17, tokenDecimals 9, cliffFeeBps 50, creatorShareOfNonProtocolBps 5000.
- `eth_getLogs` on the factory works with **≤10k-block windows** (a 200k-block
  range returns HTTP 400). `LaunchCreated` topic0
  `0x0d8c51804d67b6aa256e855176d3b6f5d0cc3657138b63947cc9eb5a1908d00a`.
  **392 launches in the last 500k blocks.**
- `AmmoraV4LaunchCurveClient.getState()` works (slow through this VM's proxy,
  ~30s; a single-field read is one eth_call). Example (curve
  `0xefd81e…751e`, Config 1): status 1 (Trading), fee 125 bps, baseReserve
  750,000 tokens, quoteReserve 0, migrationQuoteThreshold 1,000,000 WETH.
- `quoteExactInput(0.001 WETH, buy)` on an active curve
  (`0xdaa9ed…cd76`, Config 6): amountOut 25,234,167,064,316 base,
  fee 254,890,576,408 — **works**. On a fresh curve with quoteReserve 0 the
  quote **reverts** (0x48e8f5d8); the UI must show "quote unavailable" there.
- Curve status: 1 = Trading, 2 = ReadyToMigrate, 3 = Migrated
  (docs/v4-graduation-lifecycle.md). Status 3 seen live (curve `0x430209…3440`).
- Price math: sqrtPrice is Q64.64; `@ammora-protocol/math`
  `priceX128FromSqrtPriceX64` verified: 2^64 → price 1.0, 2^65 → price 4.0.

## Key SDK APIs used by the app

- `giwaSepoliaAutoRouteDeployment` — catalog (chain + all addresses).
- `getAmmoraV4NextConfigId(client, registry)` / `getAmmoraV4ConfigAtBlock(...)` —
  Config browser.
- `AmmoraV4LaunchCurveClient(publicClient, curve, {launchFactory, feePolicy})` —
  `getState()`, `quoteExactInput(amount, baseForQuote)`,
  `planSwapExactInput({...})` (unsigned swap + approval requirement),
  `planMigrate()` / `planMigrateAtBlock(n)`, `getMigrationProgressAtBlock(n)`.
- `buildCreateAmmoraV4Launch({name, symbol, metadataURI, creatorMetadataURI,
  tokenDecimals}, configId, poolCreationFee)` → `{data, value}` unsigned tx
  (to = factory). `parseAmmoraV4LaunchCreatedReceipt(receipt, factory)` →
  token/curve/creator/configId.
- `priceX128FromSqrtPriceX64` (math) — display price from sqrtPrice.
- `AmmoraDataApiClient(baseUrl)` — hosted indexer (`getLaunches`,
  `getLaunchFeed`); **no public base URL was found** in docs/examples, so the
  app discovers launches on-chain via `eth_getLogs` instead (honest, no API key).

## Warnings the app must respect

- **Config #6 is quarantined** (graduation-readiness notice, docs + agent guide):
  do not use chain 91342 / Registry 0x6d04…0aF9 / Config 6 / hash
  0x604890…667 for NEW launches even if enabled — it can sell all base inventory
  and fail migration. The app blocks Config 6 in the Create form (existing
  Config-6 curves still trade and are shown read-only).
- Graduation = final fill (status 2) THEN a separate `migrate()` transaction.
- Recommended default for new launchpads: 6.5 WETH net quote reserve target
  (docs "Build a launchpad" page); the app does not create Configs, it reuses
  existing ones, so this is guidance only.
- Creating a Config / issuing a token needs no per-team Ammora approval, but the
  caller must equal Config owner for Config creation, and the connected wallet
  pays gas + poolCreationFee (native ETH) and holds WETH separately for buys.
- RPC slowness: the public GIWA RPC is slow from this VM (~30s for a
  multi-call getState); the app shows loading states and per-call timeouts, and
  never blocks the whole page on one slow read.
