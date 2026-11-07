import { useCallback, useRef, useState } from 'react';
import { useWriteContract } from 'wagmi';
import { waitForArcReceipt } from './market.js';

/**
 * One onchain write and its lifecycle. Some wallets never answer when a request is dismissed,
 * so `reset` frees the UI at once; a request it superseded can no longer mark the action failed,
 * but if the person still signs it, the transaction is tracked as usual.
 */
export function useOnchainAction() {
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState({ status: 'IDLE', hash: null, error: null });
  const runRef = useRef(0);

  const execute = useCallback(async (request, { confirmed } = {}) => {
    const run = ++runRef.current;
    setState({ status: 'WALLET_SIGNATURE', hash: null, error: null });
    let hash = null;
    try {
      hash = await writeContractAsync(request);
      setState({ status: 'SUBMITTED', hash, error: null });
      const receipt = await waitForArcReceipt(hash, { confirmed });
      if (receipt.status !== 'success') throw new Error('The Arc transaction reverted.');
      setState({ status: 'CONFIRMED', hash, error: null });
      return receipt;
    } catch (error) {
      // A dismissed request that was already cancelled here stays silent.
      if (run === runRef.current || hash) {
        const message = error?.shortMessage ?? error?.message ?? 'Transaction failed.';
        setState({ status: 'FAILED', hash, error: message });
      }
      throw error;
    }
  }, [writeContractAsync]);

  const reset = useCallback(() => {
    runRef.current += 1;
    setState({ status: 'IDLE', hash: null, error: null });
  }, []);
  return { state, execute, reset };
}
