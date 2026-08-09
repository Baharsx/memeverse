/**
 * Getting a wallet onto Arc Testnet.
 *
 * WHAT WAS BROKEN. A WalletConnect session only carries the chains the wallet approved. MemeVerse
 * configures exactly one network, so AppKit asks for `eip155:5042002` as an *optional* namespace —
 * and a wallet that has never heard of Arc approves the session without it, on its own chains.
 * AppKit's connector then reports the session's first chain (falling back to Ethereum mainnet), so
 * the wallet connects on the wrong network, which is correct so far.
 *
 * The failure is what happens next. `wallet_switchEthereumChain` and, in the catch branch,
 * `wallet_addEthereumChain` are both sent *on the Arc chain* — a chain the session does not
 * authorise — so WalletConnect rejects them before any wallet ever sees them. Both errors are then
 * rewrapped as `UserRejectedRequestError`, destroying the real code, and the caller discarded the
 * rejection entirely. The user saw a wallet that connected, a network that would not change, and
 * no explanation.
 *
 * WHAT THIS DOES. A request is addressed to a chain the session actually authorises, which is how
 * a wallet gets asked to add a network it does not yet have. Then the switch is re-attempted, and
 * — regardless of what any of those calls resolved with — the wallet's real chain id is read back.
 * Success is only ever reported when that read says 5042002.
 *
 * This module is deliberately free of React, Wagmi, and AppKit imports: everything here is a pure
 * function over a `request`-shaped callback, so the exact provider conversation can be asserted in
 * a test without a wallet, a relay, or a browser.
 */
import { ARC_CHAIN_ID, ARC_CHAIN_ID_HEX, arc } from './arc.js';

export { ARC_CHAIN_ID, ARC_CHAIN_ID_HEX };

/**
 * The EIP-3085 registration payload, built from the one canonical Arc definition so a wallet can
 * never be handed metadata that disagrees with what the application transacts against.
 *
 * On `nativeCurrency.decimals`: this is 18, taken from the official chain definition, and it is
 * NOT a contradiction of MemeVerse's 6-decimal USDC maths. Two different things are called USDC on
 * Arc. The *native gas currency* is an 18-decimal EVM native balance, which is what EIP-3085
 * describes and what a wallet needs in order to render gas — EIP-3085 has no way to express a
 * native currency with any other precision, and wallets reject registrations that try. The *ERC-20
 * USDC token* at `arcContracts.usdc` is 6 decimals, and every amount MemeVerse prices, quotes,
 * approves, or settles goes through that token. Nothing in this file touches token maths.
 */
export function arcAddEthereumChainParams() {
  return {
    chainId: ARC_CHAIN_ID_HEX,
    chainName: arc.name,
    rpcUrls: [...arc.rpcUrls.default.http],
    blockExplorerUrls: [arc.blockExplorers.default.url],
    nativeCurrency: {
      name: arc.nativeCurrency.name,
      symbol: arc.nativeCurrency.symbol,
      decimals: arc.nativeCurrency.decimals,
    },
  };
}

/** Every place a provider hides a numeric error code, innermost first. */
function errorCodes(error) {
  const codes = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (typeof node.code === 'number') codes.push(node.code);
    visit(node.data, depth + 1);
    visit(node.data?.originalError, depth + 1);
    visit(node.originalError, depth + 1);
    visit(node.cause, depth + 1);
    visit(node.error, depth + 1);
  };
  visit(error, 0);
  return codes;
}

function errorText(error) {
  const parts = [];
  const visit = (node, depth) => {
    if (!node || depth > 4) return;
    if (typeof node === 'string') { parts.push(node); return; }
    if (typeof node !== 'object') return;
    if (typeof node.message === 'string') parts.push(node.message);
    if (typeof node.shortMessage === 'string') parts.push(node.shortMessage);
    visit(node.data, depth + 1);
    visit(node.data?.originalError, depth + 1);
    visit(node.originalError, depth + 1);
    visit(node.cause, depth + 1);
    visit(node.error, depth + 1);
  };
  visit(error, 0);
  return parts.join(' | ');
}

/**
 * "This wallet does not have Arc, or this session may not talk to it."
 *
 * 4902 is the standard answer and is what a desktop extension returns. MetaMask Mobile nests the
 * same code under `data.originalError`, and WalletConnect answers an unauthorised chain with its
 * own wording rather than a code at all — all three mean the same thing here: ask the wallet to
 * add the network.
 */
export function isUnknownChainError(error) {
  if (!error) return false;
  if (errorCodes(error).includes(4902)) return true;
  return /unrecognized chain|unrecognised chain|unknown chain|chain .{0,24}not (?:been )?added|missing or invalid.{0,40}chain|unsupported chain|chain not supported|no matching key|invalid chain id/i
    .test(errorText(error));
}

/** A person said no. Never retried, never escalated to an add prompt. */
export function isUserRejectedError(error) {
  if (!error) return false;
  const codes = errorCodes(error);
  if (codes.includes(4001) || codes.includes(5000)) return true;
  if (error?.name === 'UserRejectedRequestError') return true;
  return /user (?:rejected|denied|cancelled|canceled)|rejected by user|request rejected/i.test(errorText(error));
}

/**
 * A diagnostic small enough to log and specific enough to act on. Deliberately carries no address,
 * no project id, and no session topic — nothing here identifies a person or a credential.
 */
export function normalizeProviderError(error, { connectorId = null, method = null } = {}) {
  const codes = errorCodes(error);
  const message = (error?.shortMessage ?? error?.message ?? String(error ?? 'unknown error'));
  return {
    connector: connectorId,
    method,
    code: codes[0] ?? null,
    nestedCode: codes.find((code, index) => index > 0 && code !== codes[0]) ?? null,
    shortMessage: message.slice(0, 160),
  };
}

export const ARC_SWITCH_STATUS = Object.freeze({
  ON_ARC: 'ON_ARC',
  SESSION_REAUTH_REQUIRED: 'SESSION_REAUTH_REQUIRED',
  REJECTED: 'REJECTED',
  ADD_FAILED: 'ADD_FAILED',
  SWITCH_UNSUPPORTED: 'SWITCH_UNSUPPORTED',
  STILL_WRONG_NETWORK: 'STILL_WRONG_NETWORK',
});

export const ARC_SWITCH_MESSAGES = Object.freeze({
  [ARC_SWITCH_STATUS.SESSION_REAUTH_REQUIRED]: 'RECONNECT WALLET TO FINISH ARC SETUP',
  [ARC_SWITCH_STATUS.REJECTED]: 'ARC NETWORK SWITCH REJECTED',
  [ARC_SWITCH_STATUS.ADD_FAILED]: 'ARC NETWORK COULD NOT BE ADDED',
  [ARC_SWITCH_STATUS.SWITCH_UNSUPPORTED]: 'WALLET DOES NOT SUPPORT ARC NETWORK SWITCHING',
  [ARC_SWITCH_STATUS.STILL_WRONG_NETWORK]: 'WALLET DID NOT SWITCH TO ARC',
});

/**
 * The chain a request should be addressed to.
 *
 * For an injected provider there is only one conversation, so this is undefined and the provider
 * decides. For WalletConnect it matters enormously: a request addressed to an unauthorised chain
 * never reaches the wallet, so anything that must be *seen* by the wallet — above all the request
 * to add Arc — is addressed to a chain the session already authorises.
 */
export function authorizedRequestChain({ sessionChainIds = [], preferred = ARC_CHAIN_ID } = {}) {
  if (!Array.isArray(sessionChainIds) || sessionChainIds.length === 0) return undefined;
  if (sessionChainIds.includes(preferred)) return `eip155:${preferred}`;
  return `eip155:${sessionChainIds[0]}`;
}

/**
 * Whether this session may carry an Arc request at all.
 *
 * `@walletconnect/sign-client` validates every request against the session before it reaches the
 * relay: `isValidNamespacesChainId(namespaces, chainId)` must hold, or the call is rejected
 * locally with `Missing or invalid. request() chainId: eip155:5042002`. So a wallet can have Arc
 * configured, and the provider can report Arc from `eth_chainId`, and every transaction will
 * still fail — because the *session* never gained the chain.
 *
 * An empty list means there is no WalletConnect session (an injected wallet), where the question
 * does not arise and the answer is yes.
 */
export function arcAuthorizedForSession(sessionChainIds) {
  if (!Array.isArray(sessionChainIds) || sessionChainIds.length === 0) return true;
  return sessionChainIds.includes(ARC_CHAIN_ID);
}

/**
 * Drive a wallet onto Arc, and prove it got there.
 *
 * @param {object} options
 * @param {(args: {method: string, params?: unknown[]}, chain?: string) => Promise<unknown>} options.request
 *   The current session's provider request function. Never `window.ethereum`: for a WalletConnect
 *   session that object belongs to a different wallet, or to no wallet at all.
 * @param {() => Promise<number|null>} options.readChainId Reads the wallet's real chain id.
 * @param {number[]} [options.sessionChainIds] Chains the WalletConnect session authorises; empty
 *   for an injected wallet.
 * @param {() => Promise<number[]>} [options.readSessionChainIds] Re-reads those chains after the
 *   wallet has been dealt with. A wallet that adds Arc may or may not update the session, and only
 *   the wallet can — so this is read rather than assumed.
 * @param {string|null} [options.connectorId] For diagnostics only.
 * @returns {Promise<{ok: boolean, status: string, message: string|null, diagnostic: object|null, calls: object[]}>}
 */
export async function ensureArcNetwork({
  request,
  readChainId,
  sessionChainIds = [],
  readSessionChainIds = null,
  connectorId = null,
}) {
  const calls = [];
  const send = async (method, params, chain) => {
    calls.push({ method, params, chain: chain ?? null });
    return request({ method, params }, chain);
  };

  const settle = async (fallbackStatus, error, method) => {
    // Whatever happened above, the wallet's own answer is the only thing that decides. A wallet
    // can reject the switch and already be on Arc, and `wallet_addEthereumChain` can resolve
    // while the wallet stays exactly where it was — neither is inferred, both are read.
    const actual = await readChainId().catch(() => null);
    if (actual === ARC_CHAIN_ID) {
      /*
        Being on Arc is necessary and, over WalletConnect, not sufficient. `eth_chainId` is
        answered by the provider from its own default chain — it never reaches the wallet — and
        that default is set optimistically the moment a switch resolves. Meanwhile sign-client
        rejects every request whose chain is absent from the session. So a wallet can be on Arc,
        report Arc, and still be unable to sign anything on Arc.

        Only the wallet can add a chain to a live session, so the session is re-read here. If Arc
        did not arrive, this is reported as needing a reconnect rather than as success: a new
        session asks for Arc again, and this time the wallet has it.
      */
      const authorized = readSessionChainIds
        ? arcAuthorizedForSession(await readSessionChainIds().catch(() => sessionChainIds))
        : arcAuthorizedForSession(sessionChainIds);
      if (!authorized) {
        return {
          ok: false,
          status: ARC_SWITCH_STATUS.SESSION_REAUTH_REQUIRED,
          message: ARC_SWITCH_MESSAGES[ARC_SWITCH_STATUS.SESSION_REAUTH_REQUIRED],
          diagnostic: null,
          calls,
        };
      }
      return { ok: true, status: ARC_SWITCH_STATUS.ON_ARC, message: null, diagnostic: null, calls };
    }
    return {
      ok: false,
      status: fallbackStatus,
      message: ARC_SWITCH_MESSAGES[fallbackStatus] ?? ARC_SWITCH_MESSAGES[ARC_SWITCH_STATUS.STILL_WRONG_NETWORK],
      diagnostic: error ? normalizeProviderError(error, { connectorId, method }) : null,
      calls,
    };
  };

  const arcAuthorized = sessionChainIds.length === 0 || sessionChainIds.includes(ARC_CHAIN_ID);
  const addChain = authorizedRequestChain({ sessionChainIds });

  // 1. Ask for the switch. Skipped only when the session provably cannot carry it, in which case
  //    asking first would burn a round trip on a request the wallet will never see.
  let switchError = null;
  if (arcAuthorized) {
    try {
      await send('wallet_switchEthereumChain', [{ chainId: ARC_CHAIN_ID_HEX }],
        sessionChainIds.length ? `eip155:${ARC_CHAIN_ID}` : undefined);
      return await settle(ARC_SWITCH_STATUS.STILL_WRONG_NETWORK, null, 'wallet_switchEthereumChain');
    } catch (error) {
      if (isUserRejectedError(error)) {
        return await settle(ARC_SWITCH_STATUS.REJECTED, error, 'wallet_switchEthereumChain');
      }
      if (!isUnknownChainError(error)) {
        return await settle(ARC_SWITCH_STATUS.SWITCH_UNSUPPORTED, error, 'wallet_switchEthereumChain');
      }
      switchError = error;
    }
  }

  // 2. The wallet does not know Arc. Register it — addressed to a chain the session authorises,
  //    which is the whole reason this request now arrives at the wallet at all.
  try {
    await send('wallet_addEthereumChain', [arcAddEthereumChainParams()], addChain);
  } catch (error) {
    const status = isUserRejectedError(error)
      ? ARC_SWITCH_STATUS.REJECTED
      : ARC_SWITCH_STATUS.ADD_FAILED;
    return await settle(status, error, 'wallet_addEthereumChain');
  }

  // 3. Adding a network does not select it in every wallet, so ask once more. A failure here is
  //    not fatal on its own — step 4 still decides — because some wallets switch as part of the
  //    add and then answer this second request with "already on that chain".
  try {
    await send('wallet_switchEthereumChain', [{ chainId: ARC_CHAIN_ID_HEX }], addChain);
  } catch (error) {
    if (isUserRejectedError(error)) {
      return await settle(ARC_SWITCH_STATUS.REJECTED, error, 'wallet_switchEthereumChain');
    }
    return await settle(ARC_SWITCH_STATUS.STILL_WRONG_NETWORK, error, 'wallet_switchEthereumChain');
  }

  // 4. Read the wallet's actual chain. Nothing above is treated as proof.
  return await settle(ARC_SWITCH_STATUS.STILL_WRONG_NETWORK, switchError, 'wallet_switchEthereumChain');
}

/** The manual escape hatch, shown only once the automatic path has genuinely failed. */
export const ARC_MANUAL_NETWORK = Object.freeze({
  chainName: arc.name,
  chainIdDecimal: String(ARC_CHAIN_ID),
  chainIdHex: ARC_CHAIN_ID_HEX,
  rpcUrl: arc.rpcUrls.default.http[0],
  explorer: arc.blockExplorers.default.url,
  currencySymbol: arc.nativeCurrency.symbol,
});
