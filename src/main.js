// Leonida Launchpad — static frontend for the Ammora V4 launch system on GIWA Sepolia.
// Uses the official Ammora SDK (@ammora-protocol/sdk 0.3.9) + viem. No backend, no
// API keys, no mock data. All reads go to the public GIWA Sepolia RPC; writes only
// happen through the user's connected wallet.
import {
  giwaSepoliaAutoRouteDeployment,
  getAmmoraV4NextConfigId,
  getAmmoraV4ConfigAtBlock,
  AmmoraV4LaunchCurveClient,
  buildCreateAmmoraV4Launch,
  parseAmmoraV4LaunchCreatedReceipt,
  classifyAmmoraV4ExactInputFill,
} from '@ammora-protocol/sdk';
import { priceX128FromSqrtPriceX64 } from '@ammora-protocol/math';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
  parseAbiItem,
  erc20Abi,
} from 'viem';

// ---------------------------------------------------------------------------
// Deployment catalog (single source of truth — from the SDK, not hardcoded)
// ---------------------------------------------------------------------------
const DEPLOY = giwaSepoliaAutoRouteDeployment;
const CHAIN_ID = DEPLOY.chain.id; // 91342
const FACTORY = DEPLOY.contracts.launch.factory;
const REGISTRY = DEPLOY.contracts.launch.configRegistry;
const FEE_POLICY = DEPLOY.contracts.launch.feePolicy;
const WETH = DEPLOY.contracts.tokens.wrappedNative;
const EXPLORER = DEPLOY.chain.blockExplorerUrl;
const DEFAULT_RPC = DEPLOY.chain.rpcUrls[0];

// Ammora graduation-readiness notice: Config #6 must never be used for NEW launches.
const BLOCKED_CONFIG_ID = 6n;

const LAUNCH_CREATED_EVENT = parseAbiItem(
  'event LaunchCreated(address indexed token, address indexed curve, address indexed creator, uint256 configId, bytes32 configHash, uint16 protocolVersion, string metadataURI)',
);

const CURVE_READ_ABI = [
  { type: 'function', name: 'status', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'quoteReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'baseReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'migrationQuoteThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'migrationBaseThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

const STATUS_LABEL = { 0: 'Not trading', 1: 'Trading', 2: 'Ready to migrate', 3: 'Migrated' };
const STATUS_BADGE = { 0: '', 1: 'badge-trading', 2: 'badge-ready', 3: 'badge-migrated' };

// ---------------------------------------------------------------------------
// Clients & state
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const RPC_URL = params.get('rpc') || DEFAULT_RPC;

const chain = {
  id: DEPLOY.chain.id,
  name: DEPLOY.chain.name,
  nativeCurrency: DEPLOY.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: EXPLORER } },
  // viem requires the multicall contract to be configured on the chain object
  // (no default fallback for unknown chains). Multicall3 IS deployed at the
  // canonical address on GIWA Sepolia (verified via getBytecode, 2026-11-19).
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
};

const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { timeout: 60_000, retryCount: 1 }),
});

const state = {
  account: null,
  walletClient: null,
  walletChainId: null,
  launches: [],       // decoded LaunchCreated events, newest first
  launchesShown: 0,
  configs: [],        // {id, config} newest first
  nextConfigId: null,
  configsCursor: null, // next (older) config id to load
  configsLoading: false,
  trade: { curve: null, client: null, state: null, token: null, side: 'buy', quote: null, plan: null },
  create: { config: null, plan: null },
};

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showError(msg) {
  const el = $('global-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError() { $('global-error').classList.add('hidden'); }

function fmtBig(v, decimals, maxDp = 6) {
  if (v === undefined || v === null) return '—';
  try {
    const s = formatUnits(BigInt(v), decimals);
    const [i, f = ''] = s.split('.');
    const intPart = Number(i).toLocaleString('en-US');
    const frac = f.slice(0, maxDp).replace(/0+$/, '');
    return frac ? `${intPart}.${frac}` : intPart;
  } catch { return String(v); }
}

// Price (quote per base, human units) from a Q64.64 sqrtPrice via the SDK math package.
function priceFromSqrt(sqrtPrice, baseDecimals, quoteDecimals) {
  try {
    const px128 = priceX128FromSqrtPriceX64(BigInt(sqrtPrice)); // price * 2^128
    // price in human units, kept to 6 dp via fixed-point math:
    const fixed = (px128 * 10n ** BigInt(baseDecimals + 6)) / (2n ** 128n) / (10n ** BigInt(quoteDecimals));
    return Number(fixed) / 1e6;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ---------------------------------------------------------------------------
// Network status
// ---------------------------------------------------------------------------
async function refreshNetwork() {
  const pill = $('net-status');
  try {
    const block = await publicClient.getBlockNumber();
    pill.textContent = `GIWA Sepolia · block ${Number(block).toLocaleString('en-US')}`;
    pill.className = 'pill pill-ok';
    clearError();
  } catch (e) {
    pill.textContent = 'GIWA Sepolia RPC unreachable';
    pill.className = 'pill pill-bad';
    showError(`Cannot reach the GIWA Sepolia RPC at ${RPC_URL}. Reads are paused; check your connection and reload. (${(e.shortMessage || e.message || '').slice(0, 160)})`);
  }
}

// ---------------------------------------------------------------------------
// Wallet (EIP-1193, user signs everything themselves)
// ---------------------------------------------------------------------------
async function connectWallet() {
  const btn = $('btn-connect');
  if (!window.ethereum) {
    $('wallet-banner').textContent = 'No wallet detected in this browser. Install MetaMask (or open this page in a wallet browser) to sign transactions. Browsing and reads still work without a wallet.';
    $('wallet-banner').classList.remove('hidden');
    return;
  }
  try {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    state.account = accounts[0];
    state.walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
    const cid = await window.ethereum.request({ method: 'eth_chainId' });
    state.walletChainId = parseInt(cid, 16);
    btn.textContent = `Connected ${short(state.account)}`;
    updateWalletBanner();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Connect wallet';
    showError(`Wallet connection failed: ${(e.shortMessage || e.message || '').slice(0, 200)}`);
  }
}

function updateWalletBanner() {
  const banner = $('wallet-banner');
  if (!state.account) { banner.classList.add('hidden'); return; }
  if (state.walletChainId !== CHAIN_ID) {
    banner.innerHTML = `Your wallet is on chain ${state.walletChainId}, but this launchpad uses GIWA Sepolia (${CHAIN_ID}). <button id="btn-switch-chain" class="btn">Switch to GIWA Sepolia</button>`;
    banner.classList.remove('hidden');
    $('btn-switch-chain').addEventListener('click', switchChain);
  } else {
    banner.classList.add('hidden');
  }
}

async function switchChain() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: `0x${CHAIN_ID.toString(16)}`,
          chainName: DEPLOY.chain.name,
          nativeCurrency: DEPLOY.chain.nativeCurrency,
          rpcUrls: [DEFAULT_RPC],
          blockExplorerUrls: [EXPLORER],
        }],
      });
    } else {
      showError(`Chain switch failed: ${(e.shortMessage || e.message || '').slice(0, 200)}`);
    }
  }
}

if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', (accs) => {
    state.account = accs[0] || null;
    $('btn-connect').textContent = state.account ? `Connected ${short(state.account)}` : 'Connect wallet';
    $('btn-connect').disabled = false;
    updateWalletBanner();
  });
  window.ethereum.on?.('chainChanged', (cid) => {
    state.walletChainId = parseInt(cid, 16);
    updateWalletBanner();
  });
}

function requireWallet() {
  if (!state.account || !state.walletClient) {
    showError('Connect your wallet first — this action needs your signature.');
    return false;
  }
  if (state.walletChainId !== CHAIN_ID) {
    showError('Your wallet is on the wrong network. Switch to GIWA Sepolia (91342) first.');
    return false;
  }
  return true;
}

$('btn-connect').addEventListener('click', connectWallet);

// ---------------------------------------------------------------------------
// Shared on-chain helpers
// ---------------------------------------------------------------------------
async function tokenMeta(address) {
  try {
    const [name, symbol, decimals] = await publicClient.multicall({
      contracts: [
        { address, abi: erc20Abi, functionName: 'name' },
        { address, abi: erc20Abi, functionName: 'symbol' },
        { address, abi: erc20Abi, functionName: 'decimals' },
      ],
    });
    return {
      name: name.status === 'success' ? name.result : null,
      symbol: symbol.status === 'success' ? symbol.result : null,
      decimals: decimals.status === 'success' ? decimals.result : 18,
    };
  } catch { return { name: null, symbol: null, decimals: 18 }; }
}

async function curveSummary(curve) {
  const [status, quoteReserve, baseReserve, migrationQuoteThreshold] = await publicClient.multicall({
    contracts: [
      { address: curve, abi: CURVE_READ_ABI, functionName: 'status' },
      { address: curve, abi: CURVE_READ_ABI, functionName: 'quoteReserve' },
      { address: curve, abi: CURVE_READ_ABI, functionName: 'baseReserve' },
      { address: curve, abi: CURVE_READ_ABI, functionName: 'migrationQuoteThreshold' },
    ],
  });
  return {
    status: status.status === 'success' ? Number(status.result) : null,
    quoteReserve: quoteReserve.status === 'success' ? quoteReserve.result : null,
    baseReserve: baseReserve.status === 'success' ? baseReserve.result : null,
    migrationQuoteThreshold: migrationQuoteThreshold.status === 'success' ? migrationQuoteThreshold.result : null,
  };
}

// ---------------------------------------------------------------------------
// Discover — LaunchCreated events, newest first
// ---------------------------------------------------------------------------
async function scanLaunches() {
  const btn = $('btn-scan');
  const statusEl = $('scan-status');
  const listEl = $('launch-list');
  btn.disabled = true;
  statusEl.textContent = 'Scanning…';
  listEl.innerHTML = '';
  state.launches = [];
  state.launchesShown = 0;
  $('btn-more-launches').classList.add('hidden');
  try {
    const latest = await publicClient.getBlockNumber();
    const span = BigInt($('scan-blocks').value);
    const from = latest > span ? latest - span : 0n;
    const CHUNK = 10_000n; // the public RPC rejects wider eth_getLogs ranges
    const all = [];
    for (let start = from; start <= latest; start += CHUNK) {
      const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;
      statusEl.textContent = `Scanning blocks ${Number(start).toLocaleString()}–${Number(end).toLocaleString()}… (${all.length} found)`;
      const logs = await publicClient.getLogs({
        address: FACTORY,
        event: LAUNCH_CREATED_EVENT,
        fromBlock: start,
        toBlock: end,
      });
      all.push(...logs);
    }
    // Newest first.
    all.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    state.launches = all;
    statusEl.textContent = `${all.length} launch(es) in the last ${Number(span).toLocaleString()} blocks.`;
    if (all.length === 0) {
      listEl.innerHTML = '<p class="muted">No launches in this window. Widen the scan window and try again.</p>';
    } else {
      renderMoreLaunches();
    }
  } catch (e) {
    statusEl.textContent = '';
    showError(`Launch scan failed: ${(e.shortMessage || e.message || '').slice(0, 240)}`);
  } finally {
    btn.disabled = false;
  }
}

async function renderMoreLaunches() {
  const listEl = $('launch-list');
  const batch = state.launches.slice(state.launchesShown, state.launchesShown + 12);
  for (const log of batch) {
    const { token, curve, creator, configId } = log.args;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3><span class="token-name">Loading token…</span> <span class="badge">Config #${configId}</span> <span class="status-badge"></span></h3>
      <dl class="kv">
        <dt>Token</dt><dd><a class="addr" href="${EXPLORER}/token/${token}" target="_blank" rel="noopener">${token}</a></dd>
        <dt>Curve</dt><dd><a class="addr" href="${EXPLORER}/address/${curve}" target="_blank" rel="noopener">${curve}</a></dd>
        <dt>Creator</dt><dd class="addr">${creator}</dd>
        <dt>Block</dt><dd>${Number(log.blockNumber).toLocaleString('en-US')} · <a href="${EXPLORER}/tx/${log.transactionHash}" target="_blank" rel="noopener">tx</a></dd>
        <dt>Curve state</dt><dd class="curve-state muted">Loading live state…</dd>
      </dl>
      <div class="progress"><div style="width:0%"></div></div>
      <div class="row"><button class="btn btn-trade">Trade this curve</button></div>`;
    listEl.appendChild(card);
    card.querySelector('.btn-trade').addEventListener('click', () => {
      document.querySelector('[data-tab="trade"]').click();
      $('trade-curve').value = curve;
      loadCurve();
    });
    // Fill in live data (each card independently — one slow read never blocks the rest).
    tokenMeta(token).then((m) => {
      const name = m.symbol ? `${m.name || 'Token'} (${m.symbol})` : short(token);
      card.querySelector('.token-name').textContent = name;
    }).catch(() => { card.querySelector('.token-name').textContent = short(token); });
    curveSummary(curve).then((s) => {
      const badge = card.querySelector('.status-badge');
      if (s.status !== null) {
        badge.textContent = STATUS_LABEL[s.status] ?? `Status ${s.status}`;
        badge.className = `badge ${STATUS_BADGE[s.status] ?? ''}`;
      }
      const st = card.querySelector('.curve-state');
      if (s.quoteReserve !== null) {
        st.textContent = `Quote reserve ${fmtBig(s.quoteReserve, 18)} WETH · base reserve ${fmtBig(s.baseReserve, 18)} tokens`;
        if (s.migrationQuoteThreshold && s.migrationQuoteThreshold > 0n) {
          const pct = Math.min(100, Number((s.quoteReserve * 10_000n) / s.migrationQuoteThreshold) / 100);
          card.querySelector('.progress > div').style.width = `${pct}%`;
          st.textContent += ` · graduation ${pct.toFixed(1)}% (threshold ${fmtBig(s.migrationQuoteThreshold, 18)} WETH)`;
        }
      } else {
        st.textContent = 'Live state unavailable (RPC error).';
      }
    }).catch(() => { card.querySelector('.curve-state').textContent = 'Live state unavailable (RPC error).'; });
  }
  state.launchesShown += batch.length;
  $('btn-more-launches').classList.toggle('hidden', state.launchesShown >= state.launches.length);
}

$('btn-scan').addEventListener('click', scanLaunches);
$('btn-more-launches').addEventListener('click', renderMoreLaunches);

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------
function setTradeSide(side) {
  state.trade.side = side;
  $('btn-buy-tab').classList.toggle('active', side === 'buy');
  $('btn-sell-tab').classList.toggle('active', side === 'sell');
  $('trade-quote-asset').textContent = side === 'buy'
    ? 'You pay WETH, you receive the launch token.'
    : 'You pay the launch token, you receive WETH.';
  $('trade-quote').textContent = '';
  $('trade-plan').classList.add('hidden');
  state.trade.quote = null;
  state.trade.plan = null;
}
$('btn-buy-tab').addEventListener('click', () => setTradeSide('buy'));
$('btn-sell-tab').addEventListener('click', () => setTradeSide('sell'));

async function loadCurve() {
  const addr = $('trade-curve').value.trim();
  const box = $('trade-state');
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    showError('Enter a valid curve address (0x + 40 hex characters).');
    return;
  }
  clearError();
  box.classList.remove('hidden');
  box.innerHTML = '<p class="muted">Reading live curve state from the SDK… (the public RPC can be slow)</p>';
  $('trade-box').classList.add('hidden');
  try {
    const client = new AmmoraV4LaunchCurveClient(publicClient, addr, { launchFactory: FACTORY, feePolicy: FEE_POLICY });
    const st = await client.getState();
    const tokenM = await tokenMeta(st.baseToken);
    state.trade.curve = addr;
    state.trade.client = client;
    state.trade.state = st;
    state.trade.token = tokenM;
    const price = priceFromSqrt(st.sqrtPrice, tokenM.decimals, 18);
    const progress = st.migrationQuoteThreshold > 0n
      ? Math.min(100, Number((st.quoteReserve * 10_000n) / st.migrationQuoteThreshold) / 100)
      : null;
    box.innerHTML = `
      <h3>${esc(tokenM.symbol || short(st.baseToken))} ${tokenM.name ? `· ${esc(tokenM.name)}` : ''} <span class="badge ${STATUS_BADGE[st.status] ?? ''}">${STATUS_LABEL[st.status] ?? `Status ${st.status}`}</span></h3>
      <dl class="kv">
        <dt>Token</dt><dd><a class="addr" href="${EXPLORER}/token/${st.baseToken}" target="_blank" rel="noopener">${st.baseToken}</a> (${tokenM.decimals} decimals)</dd>
        <dt>Quote token</dt><dd class="addr">${st.quoteToken} (WETH)</dd>
        <dt>Creator</dt><dd class="addr">${st.creator}</dd>
        <dt>Config</dt><dd>#${st.configId}</dd>
        <dt>Price</dt><dd>${price !== null ? `${price.toPrecision(6)} WETH per token` : '—'} <span class="muted">(from live sqrtPrice)</span></dd>
        <dt>Reserves</dt><dd>${fmtBig(st.baseReserve, tokenM.decimals)} base · ${fmtBig(st.quoteReserve, 18)} WETH</dd>
        <dt>Graduation</dt><dd>${progress !== null ? `${progress.toFixed(2)}% of ${fmtBig(st.migrationQuoteThreshold, 18)} WETH threshold` : `sqrtPrice target ${st.migrationSqrtPrice}`}</dd>
        <dt>Fee</dt><dd>${st.currentFeeBps} bps${st.currentDynamicFeeBps ? ` + ${st.currentDynamicFeeBps} dynamic` : ''}</dd>
        <dt>Canonical pool</dt><dd class="addr">${st.canonicalPool === '0x0000000000000000000000000000000000000000' ? 'not migrated yet' : st.canonicalPool}</dd>
        <dt>As of block</dt><dd>${Number(st.asOfBlock).toLocaleString('en-US')}</dd>
      </dl>
      ${progress !== null ? `<div class="progress"><div style="width:${progress}%"></div></div>` : ''}`;
    $('trade-box').classList.remove('hidden');
    setTradeSide(state.trade.side);
    $('btn-migrate').classList.toggle('hidden', st.status !== 2);
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not read this curve: ${(esc(e.shortMessage || e.message || '')).slice(0, 240)}</p>`;
  }
}
$('btn-load-curve').addEventListener('click', loadCurve);

async function getQuote() {
  const { client, state: st, token, side } = state.trade;
  if (!client || !st) { showError('Load a curve first.'); return; }
  const raw = $('trade-amount').value;
  if (!raw || Number(raw) <= 0) { showError('Enter an amount greater than zero.'); return; }
  clearError();
  const el = $('trade-quote');
  el.textContent = 'Quoting…';
  try {
    // baseForQuote=true means the INPUT token is the base token (a sell).
    // Buy = pay quote (WETH) -> baseForQuote=false. Sell = pay base -> true.
    const baseForQuote = side === 'sell';
    const amountIn = side === 'buy' ? parseEther(raw) : parseUnits(raw, token.decimals);
    const quote = await client.quoteExactInput(amountIn, baseForQuote);
    const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
    state.trade.quote = { quote, fill, amountIn, baseForQuote };
    const outDec = side === 'buy' ? token.decimals : 18;
    const outSym = side === 'buy' ? (token.symbol || 'tokens') : 'WETH';
    el.innerHTML = `Quote: you receive ~<strong>${fmtBig(quote.amountOut, outDec)} ${esc(outSym)}</strong> ` +
      `(fee ${fmtBig(quote.fee, side === 'buy' ? 18 : token.decimals)} ${side === 'buy' ? 'WETH' : esc(token.symbol || 'tokens')}) · ` +
      `fill: ${fill.kind}${fill.refundableAmountIn > 0n ? ` · refundable input ${fmtBig(fill.refundableAmountIn, side === 'buy' ? 18 : token.decimals)}` : ''} · ` +
      `as of block ${Number(quote.asOfBlock).toLocaleString('en-US')}. ` +
      `<button id="btn-plan-swap" class="btn">Plan swap</button>`;
    $('btn-plan-swap').addEventListener('click', planSwap);
  } catch (e) {
    el.textContent = 'Quote unavailable for this curve/amount — the curve may have no liquidity yet, or the amount is outside its range. (The contract reverted the quote; nothing was spent.)';
    state.trade.quote = null;
  }
}
$('btn-quote').addEventListener('click', getQuote);

async function planSwap() {
  const { client, state: st, quote: q, side } = state.trade;
  if (!q) return;
  if (!requireWallet()) return;
  const slippageBps = Math.max(1, Math.min(5000, parseInt($('trade-slippage').value || '100', 10)));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min
  try {
    const plan = await client.planSwapExactInput({
      includedAmountIn: q.amountIn,
      baseForQuote: q.baseForQuote,
      allowPartialFill: q.fill.kind === 'graduation-boundary',
      slippageBps,
      recipient: state.account,
      deadline,
    });
    state.trade.plan = plan;
    const needApprove = plan.approvalRequirement && plan.approvalRequirement.amount > 0n;
    let allowance = 0n;
    if (needApprove) {
      allowance = await publicClient.readContract({
        address: plan.approvalRequirement.token, abi: erc20Abi, functionName: 'allowance',
        args: [state.account, plan.approvalRequirement.spender],
      });
    }
    $('trade-plan-text').textContent =
      `Swap plan (unsigned, from the SDK)\n` +
      `to:        ${plan.transaction.to}\n` +
      `value:     ${plan.transaction.value ?? 0n} wei\n` +
      `min out:   ${plan.quote.minimumAmountOut}\n` +
      `deadline:  ${new Date(Number(deadline) * 1000).toLocaleString()}\n` +
      (needApprove
        ? `approval:  ${plan.approvalRequirement.token} -> spender ${plan.approvalRequirement.spender}, amount ${plan.approvalRequirement.amount} (current allowance ${allowance})`
        : `approval:  none required`);
    $('trade-plan').classList.remove('hidden');
    $('btn-approve').classList.toggle('hidden', !(needApprove && allowance < plan.approvalRequirement.amount));
    $('trade-tx-status').textContent = '';
  } catch (e) {
    showError(`Could not build the swap plan: ${(e.shortMessage || e.message || '').slice(0, 240)}`);
  }
}

async function sendApprove() {
  const plan = state.trade.plan;
  if (!plan || !requireWallet()) return;
  const req = plan.approvalRequirement;
  const btn = $('btn-approve');
  btn.disabled = true;
  $('trade-tx-status').textContent = 'Waiting for your wallet approval…';
  try {
    const hash = await state.walletClient.writeContract({
      address: req.token, abi: erc20Abi, functionName: 'approve',
      args: [req.spender, req.amount], account: state.account, chain,
    });
    $('trade-tx-status').textContent = `Approval sent: ${hash} — waiting for confirmation…`;
    await publicClient.waitForTransactionReceipt({ hash });
    $('trade-tx-status').textContent = `Approved. You can now send the swap. (tx ${hash})`;
    btn.classList.add('hidden');
  } catch (e) {
    $('trade-tx-status').textContent = `Approval failed or rejected: ${(e.shortMessage || e.message || '').slice(0, 200)}`;
  } finally { btn.disabled = false; }
}

async function sendSwap() {
  const plan = state.trade.plan;
  if (!plan || !requireWallet()) return;
  const btn = $('btn-send-swap');
  btn.disabled = true;
  $('trade-tx-status').textContent = 'Waiting for your wallet signature…';
  try {
    const hash = await state.walletClient.sendTransaction({
      to: plan.transaction.to, data: plan.transaction.data,
      value: plan.transaction.value ?? 0n, account: state.account, chain,
    });
    $('trade-tx-status').textContent = `Swap sent: ${hash} — waiting for confirmation…`;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    $('trade-tx-status').innerHTML = receipt.status === 'success'
      ? `Swap confirmed in block ${Number(receipt.blockNumber).toLocaleString('en-US')}. <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">View on explorer</a>`
      : `Swap transaction reverted on-chain (tx ${hash}). No tokens moved beyond gas.`;
    if (receipt.status === 'success') loadCurve(); // refresh state
  } catch (e) {
    $('trade-tx-status').textContent = `Swap failed or rejected: ${(e.shortMessage || e.message || '').slice(0, 200)}`;
  } finally { btn.disabled = false; }
}

async function sendMigrate() {
  const { client } = state.trade;
  if (!client || !requireWallet()) return;
  const btn = $('btn-migrate');
  btn.disabled = true;
  $('trade-tx-status').textContent = 'Building migration plan…';
  try {
    const plan = await client.planMigrate();
    const hash = await state.walletClient.sendTransaction({
      to: plan.transaction.to, data: plan.transaction.data,
      value: plan.transaction.value ?? 0n, account: state.account, chain,
    });
    $('trade-tx-status').textContent = `Migration sent: ${hash} — waiting for confirmation…`;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    $('trade-tx-status').innerHTML = receipt.status === 'success'
      ? `Migration confirmed in block ${Number(receipt.blockNumber).toLocaleString('en-US')}. <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">View on explorer</a>`
      : `Migration reverted on-chain (tx ${hash}).`;
    if (receipt.status === 'success') loadCurve();
  } catch (e) {
    $('trade-tx-status').textContent = `Migration failed or rejected: ${(e.shortMessage || e.message || '').slice(0, 200)}`;
  } finally { btn.disabled = false; }
}
$('btn-approve').addEventListener('click', sendApprove);
$('btn-send-swap').addEventListener('click', sendSwap);
$('btn-migrate').addEventListener('click', sendMigrate);

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------
async function loadConfigs(more = false) {
  if (state.configsLoading) return; // guard: "Load older" stays clickable during a load
  state.configsLoading = true;
  const btn = $('btn-load-configs');
  const moreBtn = $('btn-more-configs');
  const statusEl = $('configs-status');
  btn.disabled = true;
  moreBtn.disabled = true;
  try {
    if (state.nextConfigId === null) {
      state.nextConfigId = await getAmmoraV4NextConfigId(publicClient, REGISTRY);
      state.configsCursor = state.nextConfigId - 1n;
      statusEl.textContent = `${state.nextConfigId - 1n} Config(s) in the registry.`;
    }
    const start = state.configsCursor;
    if (start < 1n) { statusEl.textContent = 'No more Configs.'; return; }
    const end = start - 19n > 0n ? start - 19n : 1n;
    statusEl.textContent = `Reading Configs #${start}–#${end}…`;
    const block = await publicClient.getBlockNumber();
    const batch = [];
    for (let id = start; id >= end; id--) {
      try {
        const c = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, id, block);
        batch.push({ id, config: c.config });
      } catch (e) {
        batch.push({ id, error: (e.shortMessage || e.message || '').slice(0, 120) });
      }
    }
    state.configs.push(...batch);
    state.configsCursor = end - 1n;
    renderConfigs(batch);
    $('btn-more-configs').classList.toggle('hidden', state.configsCursor < 1n);
    statusEl.textContent = `${state.configs.length} Config(s) loaded (newest first).`;
    fillCreateConfigSelect();
  } catch (e) {
    showError(`Could not read Configs: ${(e.shortMessage || e.message || '').slice(0, 240)}`);
  } finally {
    btn.disabled = false;
    moreBtn.disabled = false;
    state.configsLoading = false;
  }
}

function renderConfigs(batch) {
  const listEl = $('config-list');
  for (const { id, config, error } of batch) {
    const card = document.createElement('div');
    card.className = 'card';
    if (error) {
      card.innerHTML = `<h3>Config #${id}</h3><p class="muted">Read failed: ${esc(error)}</p>`;
    } else {
      const blocked = id === BLOCKED_CONFIG_ID;
      card.innerHTML = `
        <h3>Config #${id} ${blocked ? '<span class="badge badge-blocked">BLOCKED for new launches</span>' : ''}</h3>
        <dl class="kv">
          <dt>Quote token</dt><dd class="addr">${config.quoteToken}</dd>
          <dt>Partner</dt><dd class="addr">${config.partnerRecipient}</dd>
          <dt>Total supply</dt><dd>${fmtBig(config.totalSupply, config.tokenDecimals)} tokens (${config.tokenDecimals} decimals)</dd>
          <dt>Pool creation fee</dt><dd>${formatEther(config.poolCreationFee)} ETH</dd>
          <dt>Cliff fee</dt><dd>${config.cliffFeeBps} bps · creator share ${config.creatorShareOfNonProtocolBps} bps</dd>
          <dt>Graduation</dt><dd>${config.migrationQuoteThreshold > 0n ? `${fmtBig(config.migrationQuoteThreshold, 18)} WETH quote reserve` : 'sqrtPrice target'} · mode ${config.migrationMode}</dd>
          <dt>Leftover receiver</dt><dd class="addr">${config.leftoverReceiver}</dd>
        </dl>`;
    }
    listEl.appendChild(card);
  }
}
$('btn-load-configs').addEventListener('click', () => loadConfigs(false));
$('btn-more-configs').addEventListener('click', () => loadConfigs(true));

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
function fillCreateConfigSelect() {
  const sel = $('create-config');
  const current = sel.value;
  sel.innerHTML = '';
  for (const { id, config, error } of state.configs) {
    if (error || !config) continue;
    const opt = document.createElement('option');
    opt.value = id.toString();
    opt.textContent = id === BLOCKED_CONFIG_ID
      ? `Config #${id} — BLOCKED (graduation notice)`
      : `Config #${id} — ${fmtBig(config.totalSupply, config.tokenDecimals)} supply, ${config.tokenDecimals} dec, fee ${formatEther(config.poolCreationFee)} ETH`;
    opt.disabled = id === BLOCKED_CONFIG_ID;
    sel.appendChild(opt);
  }
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  updateCreateConfigInfo();
}

function updateCreateConfigInfo() {
  const sel = $('create-config');
  const info = $('create-config-info');
  const found = state.configs.find((c) => c.id.toString() === sel.value);
  if (!found || !found.config) { info.textContent = ''; state.create.config = null; return; }
  const c = found.config;
  state.create.config = { id: found.id, config: c };
  info.textContent = `Decimals ${c.tokenDecimals} · supply ${fmtBig(c.totalSupply, c.tokenDecimals)} · pool creation fee ${formatEther(c.poolCreationFee)} ETH (paid in native ETH) · graduation ${c.migrationQuoteThreshold > 0n ? `${fmtBig(c.migrationQuoteThreshold, 18)} WETH` : 'sqrtPrice target'}.`;
}
$('create-config').addEventListener('change', updateCreateConfigInfo);

$('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearError();
  const cfg = state.create.config;
  if (!cfg) { showError('Pick a Config first (load Configs if the list is empty).'); return; }
  if (cfg.id === BLOCKED_CONFIG_ID) { showError('Config #6 is blocked for new launches.'); return; }
  const name = $('create-name').value.trim();
  const symbol = $('create-symbol').value.trim();
  const metadataURI = $('create-meta').value.trim();
  const creatorMetadataURI = $('create-creator-meta').value.trim() || metadataURI;
  if (!name || !symbol || !metadataURI) { showError('Name, symbol and metadata URI are required.'); return; }
  try {
    const { data, value } = buildCreateAmmoraV4Launch(
      { name, symbol, metadataURI, creatorMetadataURI, tokenDecimals: cfg.config.tokenDecimals },
      cfg.id,
      cfg.config.poolCreationFee,
    );
    state.create.plan = { data, value, name, symbol, configId: cfg.id };
    $('create-plan-text').textContent =
      `Unsigned launch transaction (built with the SDK)\n` +
      `to:    ${FACTORY} (Ammora V4 launch factory)\n` +
      `value: ${formatEther(value)} ETH (pool creation fee)\n` +
      `name:  ${name}\n` +
      `symbol: ${symbol}\n` +
      `config: #${cfg.id}\n` +
      `data:  ${data.slice(0, 132)}… (${data.length} hex chars)`;
    $('create-plan').classList.remove('hidden');
    $('create-tx-status').textContent = 'Review the details above, then send with your wallet.';
    $('create-result').classList.add('hidden');
  } catch (e) {
    showError(`Could not build the launch transaction: ${(e.shortMessage || e.message || '').slice(0, 240)}`);
  }
});

$('btn-send-launch').addEventListener('click', async () => {
  const plan = state.create.plan;
  if (!plan || !requireWallet()) return;
  const btn = $('btn-send-launch');
  btn.disabled = true;
  $('create-tx-status').textContent = 'Waiting for your wallet signature…';
  try {
    const hash = await state.walletClient.sendTransaction({
      to: FACTORY, data: plan.data, value: plan.value, account: state.account, chain,
    });
    $('create-tx-status').textContent = `Launch sent: ${hash} — waiting for confirmation…`;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      $('create-tx-status').textContent = `Launch transaction reverted on-chain (tx ${hash}). No token was created.`;
      return;
    }
    const parsed = parseAmmoraV4LaunchCreatedReceipt(receipt, FACTORY);
    $('create-tx-status').textContent = `Launch confirmed in block ${Number(receipt.blockNumber).toLocaleString('en-US')}.`;
    const res = $('create-result');
    res.classList.remove('hidden');
    res.innerHTML = `
      <h3>Launch created: ${esc(plan.name)} (${esc(plan.symbol)})</h3>
      <dl class="kv">
        <dt>Token</dt><dd><a class="addr" href="${EXPLORER}/token/${parsed.token}" target="_blank" rel="noopener">${parsed.token}</a></dd>
        <dt>Curve</dt><dd><a class="addr" href="${EXPLORER}/address/${parsed.curve}" target="_blank" rel="noopener">${parsed.curve}</a></dd>
        <dt>Creator</dt><dd class="addr">${parsed.creator}</dd>
        <dt>Config</dt><dd>#${parsed.configId}</dd>
        <dt>Tx</dt><dd><a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash}</a></dd>
      </dl>
      <div class="row"><button id="btn-trade-new" class="btn">Trade this curve</button></div>`;
    $('btn-trade-new').addEventListener('click', () => {
      document.querySelector('[data-tab="trade"]').click();
      $('trade-curve').value = parsed.curve;
      loadCurve();
    });
  } catch (e) {
    $('create-tx-status').textContent = `Launch failed or rejected: ${(e.shortMessage || e.message || '').slice(0, 200)}`;
  } finally { btn.disabled = false; }
});

// ---------------------------------------------------------------------------
// About — deployment table from the catalog
// ---------------------------------------------------------------------------
function renderDeployTable() {
  const rows = [
    ['Chain', `${DEPLOY.chain.name} (${DEPLOY.chain.id})`],
    ['RPC', RPC_URL],
    ['Explorer', EXPLORER],
    ['Environment / slot', `${DEPLOY.environment} / ${DEPLOY.slot}`],
    ['Launch factory', FACTORY],
    ['Config registry', REGISTRY],
    ['Fee policy', FEE_POLICY],
    ['First-buy executor', DEPLOY.contracts.launch.firstBuyExecutor],
    ['Graduation adapter', DEPLOY.contracts.launch.graduationAdapter],
    ['Concentrated factory', DEPLOY.contracts.launch.concentratedFactory],
    ['Compounding factory', DEPLOY.contracts.launch.compoundingFactory],
    ['WETH', WETH],
    ['Token policy registry', DEPLOY.contracts.policy.tokenPolicyRegistry],
  ];
  $('deploy-table').innerHTML = rows.map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td class="addr">${esc(v)}</td></tr>`).join('');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
renderDeployTable();
refreshNetwork();
setInterval(refreshNetwork, 30_000);
setTradeSide('buy');
loadConfigs(false); // preload Configs (also fills the Create dropdown)
scanLaunches();     // preload recent launches
