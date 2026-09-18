/**
 * Shared Circle / Arc identity for deploy and setup scripts.
 *
 * Reads the already-resolved server config so a script cannot silently target ARC-TESTNET
 * while ARC_NETWORK=mainnet. Product e2e scripts that are named *-testnet.js stay testnet-only.
 */
export function circleChain(config) {
  return {
    chainId: config.arcChainId,
    blockchain: config.circleChainCode,
    explorer: config.arcExplorerUrl,
    label: config.arcNetwork === 'mainnet' ? 'Arc mainnet' : 'Arc Testnet',
  };
}

export function assertCircleDeployWallet(wallet, blockchain) {
  if (!wallet || wallet.blockchain !== blockchain || wallet.accountType !== 'EOA') {
    throw new Error(`Deployment wallet must be a live ${blockchain} EOA.`);
  }
}
