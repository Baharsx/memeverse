import { useCallback, useState } from 'react';
import { useWriteContract } from 'wagmi';
import { marketPublicClient } from './market';

export function useOnchainAction() {
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState({ status: 'IDLE', hash: null, error: null });

  const execute = useCallback(async (request) => {
    setState({ status: 'REQUESTED', hash: null, error: null });
    try {
      setState({ status: 'WALLET_SIGNATURE', hash: null, error: null });
      const hash = await writeContractAsync(request);
      setState({ status: 'SUBMITTED', hash, error: null });
      const receipt = await marketPublicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== 'success') throw new Error('The Arc transaction reverted.');
      setState({ status: 'CONFIRMED', hash, error: null });
      return receipt;
    } catch (error) {
      const message = error?.shortMessage ?? error?.message ?? 'Transaction failed.';
      setState((current) => ({ status: 'FAILED', hash: current.hash, error: message }));
      throw error;
    }
  }, [writeContractAsync]);

  const reset = useCallback(() => setState({ status: 'IDLE', hash: null, error: null }), []);
  return { state, execute, reset };
}
