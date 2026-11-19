# Leonida Launchpad

A token launchpad + bonding-curve exchange built with the official **Ammora SDK**
(`@ammora-protocol/sdk` 0.3.9) on **GIWA Sepolia** (chain 91342). Static frontend —
no backend, no secrets, no API keys. Deployable to GitHub Pages from `docs/`.

Built for the **Ammora Season 2 Builder mission** ("Ship an exchange or launchpad
with the Ammora SDK").

> Testnet only. Ammora is beta testnet software with no independent security
> audit. Nothing here is financial advice; every transaction is signed by the
> user's own wallet, in their own browser.

## What it does

| Tab | Function |
|---|---|
| **Discover** | Lists real launches from the V4 factory, read live from on-chain `LaunchCreated` events (newest first). Each card shows the token name/symbol, live curve state (status, reserves, graduation progress) via the SDK + viem multicall. |
| **Trade** | Loads any curve with `AmmoraV4LaunchCurveClient.getState()`, shows live price (from `sqrtPrice` via `@ammora-protocol/math`), reserves, fee and graduation progress. Buy/sell with `quoteExactInput` + `classifyAmmoraV4ExactInputFill`, then `planSwapExactInput` builds an unsigned tx; the user approves (ERC-20, only if needed) and signs with their wallet. A Migrate button appears when a curve is ready (`status = 2`). |
| **Create** | Builds a new token + bonding curve from an existing on-chain Config with `buildCreateAmmoraV4Launch`. The user picks a Config (live from the registry), enters name/symbol/metadata URI, reviews the unsigned tx, then signs. The receipt is parsed with `parseAmmoraV4LaunchCreatedReceipt` to show the new token + curve. |
| **Configs** | All Configs in the registry, newest first, read live with `getAmmoraV4ConfigAtBlock`. |
| **About** | The full GIWA Sepolia deployment table, taken from the SDK's own catalog (`giwaSepoliaAutoRouteDeployment`) — nothing hardcoded. |

Safety details:

- **Config #6 is blocked for new launches** (Ammora graduation-readiness notice:
  it can sell all base inventory and fail migration). It is disabled in the
  Create dropdown, flagged in the Configs list, and rejected again in the
  submit handler. Existing Config-6 curves still trade and are shown read-only.
- `baseForQuote` semantics follow the official example: `true` = input is the
  base token (a sell), `false` = input is WETH (a buy).
- Quotes that revert (e.g. a fresh curve with no liquidity) show "quote
  unavailable" — nothing is spent.
- No mock data anywhere. If a read fails, the UI says so instead of inventing
  numbers.

## Key addresses (GIWA Sepolia, auto-route slot `v4-auto-route-20260917`)

All from the SDK catalog; see the About tab in the app.

- Launch factory: `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA`
- Config registry: `0x6d043014972b87406C4757a5f2d655A24e0b0aF9`
- Fee policy: `0x17B44C14F640fD429740FA3220f47a567c62725C`
- WETH (quote token): `0x4200000000000000000000000000000000000006`
- RPC: `https://sepolia-rpc.giwa.io` — Explorer: `https://sepolia-explorer.giwa.io`

## Run locally

```bash
npm install
npm run build    # bundles src/main.js -> docs/app.js, copies index.html + style.css
npm run serve    # serves docs/ on http://127.0.0.1:8080
```

Optional: `?rpc=<url>` overrides the RPC endpoint (used for local verification
through `proxy.mjs`, a dev-only JSON-RPC proxy — not part of the deploy).

## Deploy

GitHub Pages, source `main` branch, folder `/docs`. The deployed site calls the
public GIWA RPC directly from the visitor's browser.

## Verification (2026-11-19, headless Chromium + local RPC proxy)

- Build passes; bundle `docs/app.js` 425.8 kB (minified).
- Live block number renders (`GIWA Sepolia · block 41,745,123`).
- Discover: 15 launches in the last 100,000 blocks; all 12 rendered cards show
  real token names and live curve state (0 RPC errors).
- Configs: all 62 Configs load; exactly one `BLOCKED` badge (Config #6).
- Trade: real curve `0xdaa9…cd76` (JonTes/JTES, Config #6) loads with live
  price 0.0255060 WETH/token; a 0.001 WETH buy quotes ~37,819,268.89 JTES,
  fee 0.00001 WETH, fill `full`.
- **0 console errors, 0 page errors.**
- Screenshots: `screenshots/` (01-discover … 06-about).

Known notes:

- The public GIWA RPC is slow from some networks (a full curve read can take
  ~30 s); the UI shows loading states and never crashes on a slow read.
- `eth_getLogs` on the public RPC rejects ranges wider than 10,000 blocks, so
  the Discover scan chunks its requests.
- viem needs `contracts.multicall3` configured on the chain object for
  unknown chains (Multicall3 is deployed at the canonical address on GIWA
  Sepolia — verified via `getBytecode`).

## Links

- SDK: https://www.npmjs.com/package/@ammora-protocol/sdk (0.3.9, MIT)
- Repo: https://github.com/ammora-labs/ammora-protocol
- Docs: https://docs.ammora.org · quickstart: https://docs.ammora.org/ai/sdk-quickstart.md
- Examples: https://github.com/AmmoraLabs/ammora-examples
- Deployment manifest: https://ammora-docs.vercel.app/deployments/giwa-sepolia-v4/verification-manifest.json
- Ammora Season 2: https://ammora.org/waitlist

Research notes: `RESEARCH.md`.
