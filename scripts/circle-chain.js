/**
 * Shared Circle / Arc identity for deploy and setup scripts.
 *
 * Circle is a testnet path only. These scripts refuse Arc mainnet (chain 5042) before any
 * Circle client is constructed. Product e2e scripts named *-testnet.js stay on 5042002.
 */
export function circleChain(config) {
  const network = config?.arcNetwork;
  const chainId = config?.arcChainId;
  if (
    network === 'mainnet'
    || chainId === 5042
    || config?.circleChainCode === 'ARC'
    || (config?.circleChainCode == null && network === 'mainnet')
  ) {
    throw new Error(
      'Circle is not used on Arc mainnet (chain 5042). Refusing circle:setup, circle:fund, and circle:deploy. Deploy the factory with npm run deploy:mainnet:eoa.',
    );
  }
  if (config?.circleChainCode !== 'ARC-TESTNET' || chainId !== 5042002) {
    throw new Error('Circle deploy scripts only run on Arc Testnet (ARC-TESTNET, chain 5042002).');
  }
  return {
    chainId: 5042002,
    blockchain: 'ARC-TESTNET',
    explorer: config.arcExplorerUrl,
    label: 'Arc Testnet',
  };
}

export function assertCircleDeployWallet(wallet, blockchain) {
  if (!wallet || wallet.blockchain !== blockchain || wallet.accountType !== 'EOA') {
    throw new Error(`Deployment wallet must be a live ${blockchain} EOA.`);
  }
}
