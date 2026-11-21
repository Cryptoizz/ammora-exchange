// Ammora Launch Exchange — GIWA Sepolia demo exchange.
//
// Everything protocol-specific comes from the official SDK
// (@ammora-protocol/sdk@0.3.9):
//   * giwaSepoliaAutoRouteDeployment  -> chain + contract catalog (no hardcoded addresses)
//   * segmentedALCLaunchFactoryV3Abi   -> LaunchCreated events used for launch discovery
//   * segmentedBondingCurveV3Abi       -> curve state reads + swapExactInput calldata
//   * ALCClient                        -> live curve quotes (quoteExactInput)
//
// Reads are permissionless. Swaps are encoded from the SDK curve ABI with the
// minimum output taken from the SDK quote, and are signed by the user's wallet.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  erc20Abi,
  formatUnits,
  parseUnits,
  encodeFunctionData,
} from 'viem';
import {
  giwaSepoliaAutoRouteDeployment,
  ALCClient,
  segmentedALCLaunchFactoryV3Abi,
  segmentedBondingCurveV3Abi,
} from '@ammora-protocol/sdk';

/* ------------------------------------------------------------------ setup */

const deployment = giwaSepoliaAutoRouteDeployment;
const EXPLORER = deployment.chain.blockExplorerUrl;

const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: deployment.chain.rpcUrls } },
  blockExplorers: { default: { name: 'GIWA Sepolia Explorer', url: EXPLORER } },
});

const publicClient = createPublicClient({
  chain,
  transport: http(undefined, { timeout: 60_000, retryCount: 1 }),
});

const FACTORY = deployment.contracts.launch.factory;
const REGISTRY = deployment.contracts.launch.configRegistry;
const LAUNCH_CREATED = segmentedALCLaunchFactoryV3Abi.find(
  (x) => x.type === 'event' && x.name === 'LaunchCreated',
);

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v, dec, max = 6) => {
  const s = formatUnits(v, dec);
  const [i, f = ''] = s.split('.');
  return f ? `${i}.${f.slice(0, max).replace(/0+$/, '') || '0'}` : i;
};

/* ------------------------------------------------------------------ state */

let launches = []; // { token, curve, creator, configId, name, symbol, decimals, quoteSymbol, quoteDecimals, status, quoteReserve }
let selected = null; // launch + curve detail
let side = 'buy'; // 'buy' | 'sell'
let account = null;
let walletClient = null;
let quoteSeq = 0;

/* ------------------------------------------------------------- block ticker */

async function tickBlock() {
  try {
    const n = await publicClient.getBlockNumber();
    $('block-label').textContent = `block ${n.toString()}`;
    $('net-dot').classList.remove('err');
  } catch {
    $('net-dot').classList.add('err');
    $('block-label').textContent = 'RPC unreachable';
  }
}
tickBlock();
setInterval(tickBlock, 15_000);

/* --------------------------------------------------------- launch discovery */

async function tokenMeta(address) {
  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'name' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { name, symbol, decimals };
}

async function curveRead(curve, fn, args = []) {
  return publicClient.readContract({
    address: curve,
    abi: segmentedBondingCurveV3Abi,
    functionName: fn,
    args,
  });
}

async function loadLaunches() {
  const list = $('launch-list');
  list.innerHTML = '<div class="skeleton">Scanning factory events…</div>';
  try {
    const head = await publicClient.getBlockNumber();
    const logs = [];
    // Scan backwards in 10k-block chunks (RPC range limit) until we have enough.
    for (let end = head; end > head - 120_000n && logs.length < 10; end -= 10_000n) {
      const chunk = await publicClient.getLogs({
        address: FACTORY,
        event: LAUNCH_CREATED,
        fromBlock: end - 9_999n,
        toBlock: end,
      });
      logs.push(...chunk.reverse());
    }
    const seen = new Set();
    const raw = logs.filter((l) => {
      const t = l.args.token.toLowerCase();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    }).slice(0, 10);

    launches = (
      await Promise.all(
        raw.map(async (l) => {
          try {
            const [meta, quoteToken, status, quoteReserve] = await Promise.all([
              tokenMeta(l.args.token),
              curveRead(l.args.curve, 'quoteToken'),
              curveRead(l.args.curve, 'status'),
              curveRead(l.args.curve, 'quoteReserve'),
            ]);
            const qMeta = await tokenMeta(quoteToken);
            return {
              token: l.args.token,
              curve: l.args.curve,
              creator: l.args.creator,
              configId: l.args.configId,
              block: l.blockNumber,
              ...meta,
              quoteToken,
              quoteSymbol: qMeta.symbol,
              quoteDecimals: qMeta.decimals,
              status: Number(status),
              quoteReserve,
            };
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);

    renderLaunches();
    if (launches.length) selectLaunch(launches[0]);
    else list.innerHTML = '<div class="skeleton">No launches found in the scanned range.</div>';
  } catch (e) {
    list.innerHTML = `<div class="skeleton">Could not reach the GIWA Sepolia RPC: ${e.shortMessage || e.message}</div>`;
  }
}

function renderLaunches() {
  const list = $('launch-list');
  list.innerHTML = '';
  for (const l of launches) {
    const b = document.createElement('button');
    b.className = 'launch-item' + (selected && selected.token === l.token ? ' selected' : '');
    b.innerHTML = `
      <div class="avatar">${(l.symbol || '?').slice(0, 4)}</div>
      <div class="launch-main">
        <div class="launch-name">${l.name} <span style="color:var(--muted)">${l.symbol}</span></div>
        <div class="launch-meta">Config #${l.configId} · curve ${short(l.curve)}</div>
      </div>
      <div class="launch-side">
        <div><span class="status-dot ${l.status === 1 ? '' : 'off'}"></span>${l.status === 1 ? 'Active' : `Status ${l.status}`}</div>
        <div class="res">${fmt(l.quoteReserve, l.quoteDecimals, 4)} ${l.quoteSymbol} reserve</div>
      </div>`;
    b.onclick = () => selectLaunch(l);
    list.appendChild(b);
  }
}

/* ------------------------------------------------------------- curve detail */

async function selectLaunch(l) {
  selected = { ...l, baseReserve: null, threshold: null, feeBps: null };
  renderLaunches();
  $('selected-token').innerHTML =
    `<strong>${l.name} (${l.symbol})</strong> · pay with ${l.quoteSymbol} · curve ${short(l.curve)}`;
  $('curve-stats').hidden = true;
  updateSideUI();
  try {
    const [baseReserve, threshold, feeBps] = await Promise.all([
      curveRead(l.curve, 'baseReserve'),
      curveRead(l.curve, 'migrationQuoteThreshold'),
      curveRead(l.curve, 'currentFeeBps'),
    ]);
    if (!selected || selected.token !== l.token) return;
    Object.assign(selected, { baseReserve, threshold, feeBps: Number(feeBps) });
    $('cs-status').textContent =
      l.status === 1 ? 'Active' : l.status === 2 ? 'Ready to migrate' : l.status === 3 ? 'Migrated' : `Status ${l.status}`;
    $('cs-qres').textContent = `${fmt(l.quoteReserve, l.quoteDecimals)} ${l.quoteSymbol}`;
    $('cs-bres').textContent = `${fmt(baseReserve, l.decimals)} ${l.symbol}`;
    $('cs-fee').textContent = `${(Number(feeBps) / 100).toFixed(2)}%`;
    const pct =
      threshold > 0n ? Math.min(100, Number((l.quoteReserve * 10_000n) / threshold) / 100) : 0;
    $('cs-prog').style.width = `${pct}%`;
    $('cs-prog-label').textContent = `${pct.toFixed(1)}% of ${fmt(threshold, l.quoteDecimals, 2)} ${l.quoteSymbol}`;
    $('cs-curve-link').href = `${EXPLORER}/address/${l.curve}`;
    $('cs-curve-link').textContent = short(l.curve);
    $('cs-token-link').href = `${EXPLORER}/address/${l.token}`;
    $('cs-token-link').textContent = short(l.token);
    $('curve-stats').hidden = false;
  } catch {
    /* curve stats are best-effort; quoting below is the source of truth */
  }
  refreshBalances();
  updateQuote();
}

/* ------------------------------------------------------------------- wallet */

async function connectWallet() {
  const btn = $('connect-btn');
  if (!window.ethereum) {
    btn.textContent = 'No wallet detected';
    return;
  }
  try {
    walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
    const [addr] = await walletClient.requestAddresses();
    account = addr;
    try {
      await walletClient.switchChain({ id: chain.id });
    } catch {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: `0x${chain.id.toString(16)}`,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: deployment.chain.rpcUrls,
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    }
    btn.textContent = short(account);
    refreshBalances();
    updateSwapButton();
  } catch (e) {
    setStatus(`Wallet connection failed: ${e.shortMessage || e.message}`, 'err');
  }
}

async function refreshBalances() {
  const line = $('balance-line');
  if (!account || !selected) {
    line.textContent = account ? '' : 'Connect a wallet to see balances and swap.';
    return;
  }
  try {
    const inToken = side === 'buy' ? selected.quoteToken : selected.token;
    const inDec = side === 'buy' ? selected.quoteDecimals : selected.decimals;
    const inSym = side === 'buy' ? selected.quoteSymbol : selected.symbol;
    const bal = await publicClient.readContract({
      address: inToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    });
    line.textContent = `Your balance: ${fmt(bal, inDec)} ${inSym}`;
  } catch {
    line.textContent = '';
  }
}

/* -------------------------------------------------------------------- quote */

function currentInput() {
  if (!selected) return null;
  const raw = $('amount').value.trim();
  if (!raw || Number.isNaN(Number(raw))) return null;
  const inDec = side === 'buy' ? selected.quoteDecimals : selected.decimals;
  try {
    return parseUnits(raw, inDec);
  } catch {
    return null;
  }
}

async function updateQuote() {
  const seq = ++quoteSeq;
  const amountIn = currentInput();
  const btn = $('swap-btn');
  if (!selected || amountIn === null || amountIn <= 0n) {
    $('q-out').textContent = '—';
    $('q-fee').textContent = '—';
    $('q-min').textContent = '—';
    $('q-rate').textContent = '—';
    btn.disabled = true;
    btn.textContent = selected ? 'Enter an amount' : 'Select a launch';
    return;
  }
  $('q-out').textContent = '…';
  try {
    const alc = new ALCClient(publicClient, selected.curve, REGISTRY);
    const q = await alc.quoteExactInput(amountIn, side === 'sell');
    if (seq !== quoteSeq) return;
    const inSym = side === 'buy' ? selected.quoteSymbol : selected.symbol;
    const outSym = side === 'buy' ? selected.symbol : selected.quoteSymbol;
    const inDec = side === 'buy' ? selected.quoteDecimals : selected.decimals;
    const outDec = side === 'buy' ? selected.decimals : selected.quoteDecimals;
    const minOut = (q.amountOut * 9_900n) / 10_000n;
    $('q-out').textContent = `${fmt(q.amountOut, outDec)} ${outSym}`;
    $('q-fee').textContent = `${fmt(q.fee, inDec)} ${inSym}`;
    $('q-min').textContent = `${fmt(minOut, outDec)} ${outSym}`;
    $('q-rate').textContent =
      q.amountOut > 0n
        ? `1 ${inSym} ≈ ${fmt((q.amountOut * 10n ** BigInt(inDec)) / amountIn, outDec, 4)} ${outSym}`
        : '—';
    selected.lastQuote = { amountIn, minOut };
    updateSwapButton();
  } catch (e) {
    if (seq !== quoteSeq) return;
    $('q-out').textContent = 'quote unavailable';
    $('q-fee').textContent = $('q-min').textContent = $('q-rate').textContent = '—';
    btn.disabled = true;
    btn.textContent = 'Curve not quotable';
  }
}

function updateSwapButton() {
  const btn = $('swap-btn');
  if (!selected) return;
  if (!account) {
    btn.disabled = false;
    btn.textContent = 'Connect wallet to swap';
    return;
  }
  if (selected.lastQuote) {
    btn.disabled = false;
    btn.textContent = side === 'buy' ? `Buy ${selected.symbol}` : `Sell ${selected.symbol}`;
  }
}

/* --------------------------------------------------------------------- swap */

function setStatus(msg, kind = '') {
  const el = $('swap-status');
  el.textContent = msg;
  el.className = `swap-status ${kind}`;
}

async function doSwap() {
  if (!account) return connectWallet();
  if (!selected?.lastQuote) return;
  const { amountIn, minOut } = selected.lastQuote;
  const inToken = side === 'buy' ? selected.quoteToken : selected.token;
  const btn = $('swap-btn');
  btn.disabled = true;
  try {
    setStatus('Checking allowance…');
    const allowance = await publicClient.readContract({
      address: inToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, selected.curve],
    });
    if (allowance < amountIn) {
      setStatus('Approving token spend in your wallet…');
      const ah = await walletClient.writeContract({
        address: inToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [selected.curve, amountIn],
        account,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: ah });
    }
    setStatus('Confirm the swap in your wallet…');
    const data = encodeFunctionData({
      abi: segmentedBondingCurveV3Abi,
      functionName: 'swapExactInput',
      args: [
        amountIn,
        minOut,
        side === 'sell', // baseForQuote
        false, // allowPartialFill
        account, // recipient
        BigInt(Math.floor(Date.now() / 1000) + 1200), // deadline
      ],
    });
    const hash = await walletClient.sendTransaction({ account, chain, to: selected.curve, data });
    setStatus(`Swap sent: ${hash} — waiting for confirmation…`);
    await publicClient.waitForTransactionReceipt({ hash });
    setStatus(`Swap confirmed. Tx: ${EXPLORER}/tx/${hash}`, 'ok');
    selected.lastQuote = null;
    await selectLaunch(selected);
  } catch (e) {
    setStatus(`Swap failed: ${e.shortMessage || e.message}`, 'err');
  } finally {
    btn.disabled = false;
    updateSwapButton();
  }
}

/* ----------------------------------------------------------------------- UI */

function updateSideUI() {
  $('tab-buy').classList.toggle('active', side === 'buy');
  $('tab-sell').classList.toggle('active', side === 'sell');
  if (selected) {
    $('amount-label').textContent =
      side === 'buy' ? `You pay (${selected.quoteSymbol})` : `You sell (${selected.symbol})`;
    $('amount-symbol').textContent = side === 'buy' ? selected.quoteSymbol : selected.symbol;
  }
  if (selected) selected.lastQuote = null;
  refreshBalances();
  updateQuote();
}

$('tab-buy').onclick = () => { side = 'buy'; updateSideUI(); };
$('tab-sell').onclick = () => { side = 'sell'; updateSideUI(); };
$('connect-btn').onclick = connectWallet;
$('swap-btn').onclick = doSwap;
$('refresh-btn').onclick = loadLaunches;
let debounce;
$('amount').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(updateQuote, 400);
});

/* ------------------------------------------------------------------ catalog */

function renderCatalog() {
  const c = deployment.contracts;
  const entries = [
    ['Launch factory (V4)', c.launch.factory],
    ['Config registry', c.launch.configRegistry],
    ['First-buy executor', c.launch.firstBuyExecutor],
    ['Math module', c.launch.mathModule],
    ['Graduation adapter', c.launch.graduationAdapter],
    ['Fee policy', c.launch.feePolicy],
    ['ALMM factory', c.liquidityMarketMaker.factory],
    ['ALMM position manager', c.liquidityMarketMaker.positionManager],
    ['Bin lens', c.liquidityMarketMaker.binLens],
    ['Execution registry', c.routers.executionRegistry],
    ['Native router', c.routers.native],
    ['Genesis vault factory', c.vaults.genesisFactory],
    ['Token policy registry', c.policy.tokenPolicyRegistry],
    ['WETH (wrapped native)', c.tokens.wrappedNative],
  ].filter(([, a]) => a);
  $('catalog-grid').innerHTML = entries
    .map(
      ([label, addr]) => `
      <div class="catalog-item">
        <div class="label">${label}</div>
        <a class="addr" href="${EXPLORER}/address/${addr}" target="_blank" rel="noreferrer">${addr}</a>
      </div>`,
    )
    .join('');
}

renderCatalog();
loadLaunches();
