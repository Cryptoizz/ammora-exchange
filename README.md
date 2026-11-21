# Ammora Launch Exchange

A minimal, real demo exchange for **Ammora V4 bonding-curve token launches** on
**GIWA Sepolia (chain 91342)**, built with the official
[`@ammora-protocol/sdk`](https://www.npmjs.com/package/@ammora-protocol/sdk) **0.3.9**
and [viem](https://viem.sh). Built for the Ammora Season 2 builder mission
("Ship an exchange or launchpad with the Ammora SDK").

It is a single static page (Vite + vanilla JS, no backend):

- **Live launch discovery** — scans `LaunchCreated` events of the official V4 launch
  factory on-chain and lists real launched tokens (newest first).
- **Live curve quotes** — buy/sell quotes come from the SDK's
  `ALCClient.quoteExactInput`, read directly from each launch's bonding curve.
- **Curve stats** — status, reserves, curve fee and graduation progress, read via the
  SDK's published curve ABI.
- **Real swaps** — connect a wallet, and the app approves the input token if needed and
  sends the curve's `swapExactInput` with the minimum output bound to the SDK quote
  (1% slippage). You sign everything in your own wallet; the app never holds keys.
- **SDK deployment catalog** — the contract panel is rendered from the SDK's
  `giwaSepoliaAutoRouteDeployment` export. No contract address is hardcoded in the app.

## How the SDK is used (file / function level)

All logic lives in [`src/main.js`](src/main.js):

| SDK export | Where | Purpose |
| --- | --- | --- |
| `giwaSepoliaAutoRouteDeployment` | top of `main.js`, `renderCatalog()` | Chain definition (id 91342, RPC `https://sepolia-rpc.giwa.io`, explorer), launch factory + config registry addresses, and the whole contract catalog panel. |
| `segmentedALCLaunchFactoryV3Abi` | `loadLaunches()` | The `LaunchCreated` event ABI used with viem `getLogs` (10k-block chunks, RPC range limit) to discover launches. |
| `segmentedBondingCurveV3Abi` | `curveRead()`, `selectLaunch()`, `doSwap()` | Curve getters (`baseToken`, `quoteToken`, `status`, `baseReserve`, `quoteReserve`, `migrationQuoteThreshold`, `currentFeeBps`) and `swapExactInput` calldata encoding. |
| `ALCClient` | `updateQuote()` | `new ALCClient(publicClient, curve, configRegistry)` → `quoteExactInput(amountIn, baseForQuote)` for live buy/sell quotes, fees and min-received. |

Token names/symbols/decimals and balances are standard ERC-20 reads via viem.

## Verified live behaviour (21 Nov 2026)

The exact call sequence the page runs was executed against the live chain:

- Factory scan found real launches, e.g. token `test` (**TESTD**, 9 decimals) on curve
  `0x054062aaA25219Dd6B9038C4EE7c6117a1ed4201`, quoted in WETH.
- SDK buy quote: `0.01 WETH → 159,431,529.65 TESTD` (fee `0.0001 WETH`).
- SDK sell quote: `1000 TESTD → 0.00098009 WETH`.

## Known SDK limitations (found while integrating, reported honestly)

- `ALCClient.getState()` / `getMigrationProgress()` / `planSwapExactInput()` currently
  fail on live curves because the contracts' `protocolLiquidityMigrationFeeBps()`
  getter reverts, and the SDK reads it as part of those calls. This app therefore reads
  curve state field-by-field via the SDK curve ABI and encodes swaps itself, while
  still using the SDK client for quotes.
- `ALCClient.getConfig()` / `listConfigs()` throw a bigint→Number "not in safe integer
  range" error when decoding real Config Registry data (e.g. config IDs 1, 2, 3, 71),
  so the app does not depend on them.
- The SDK's `AmmoraDataApiClient` endpoint (`ammora-giwa-sepolia-data.fly.dev`)
  returned HTTP 503 during development, so launch discovery is done on-chain via
  factory events instead — no dependency on the Data API.
- The GitHub repo linked from ammora.org (`AmmoraProtocol/Ammora-sdk`) returns 404
  publicly; the SDK is distributed via npm and documented at
  [docs.ammora.org](https://docs.ammora.org/ai/sdk-quickstart.md), which is what this
  integration follows.

## Run locally

```bash
npm install
npm run dev      # dev server
npm run build    # production build -> dist/
npm run preview  # serve the production build locally
```

## Deploy

The build output is a fully static `dist/` folder (relative asset paths), deployable
as-is to Vercel, GitHub Pages, Netlify, or any static host. No environment variables
or backend are required. The page talks directly from the visitor's browser to the
public GIWA Sepolia RPC (`https://sepolia-rpc.giwa.io`) and to the visitor's wallet.

## Notes

- Testnet only. GIWA Sepolia ETH/WETH have no real value.
- Buying a launch token spends **WETH** (the curve quote token), not native ETH —
  wrap ETH first if your wallet only holds ETH.
- The SDK is beta testnet software (its own README says it has no completed
  independent audit); do not reuse this code with real funds without your own review.
