import { useAccount } from 'wagmi';
import { arc } from './arc.js';

/**
 * Which chain the connected wallet is actually on.
 *
 * `useChainId()` cannot answer this. It reads `config.state.chainId`, and Wagmi deliberately
 * refuses to move that value to a chain the config does not list — MemeVerse lists exactly one,
 * so a wallet sitting on Ethereum mainnet still reported 5042002 and every "are we on Arc?" check
 * in the app said yes. The switch-to-Arc control showed ON, and the sign buttons were enabled,
 * for a wallet that was not on Arc at all.
 *
 * `useAccount().chainId` comes from the connection itself and reports the wallet's real chain,
 * unsupported ones included. Every network guard reads it through this hook so there is one
 * answer, and so a transaction can never be offered against an unintended network.
 */
export function useArcNetwork() {
  const { address, chainId, isConnected } = useAccount();
  return {
    address,
    isConnected,
    chainId: chainId ?? null,
    onArc: isConnected && chainId === arc.id,
    wrongNetwork: isConnected && chainId !== arc.id,
  };
}
