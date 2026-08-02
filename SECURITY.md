# Security Policy

MemeVerse is currently a public Arc Testnet simulation. It does not accept real assets, provide financial advice, or offer support through unsolicited direct messages.

## User safety

- Verify Arc network information against `https://docs.arc.io/` and network health against `https://status.arc.io/`.
- Confirm Arc Testnet chain ID `5042002` before signing.
- Never share a seed phrase, private key, one-time code, or wallet backup with MemeVerse, Circle, Arc community members, or anyone claiming to provide support.
- Treat unsolicited support messages, token claims, role offers, and requests to install unknown software as hostile.
- Inspect the wallet simulation and destination before signing. A transaction hash is not a receipt until the transaction is confirmed successfully.
- Arc Testnet assets have no real-world value.

## Application security requirements

- No private key or privileged Circle credential may be bundled into the browser application or committed to Git.
- Production services must validate chain ID, contract address, recipient, amount, fee assumptions, and transaction status server-side.
- Webhooks must be authenticated and deduplicated by notification ID because delivery can be at least once.
- Retry logic must distinguish pre-broadcast failures from submitted transactions and persist the latest transaction hash before retrying.
- Transaction Memo and Multicall3From flows must use a directly signing EOA until Arc documentation states otherwise; smart contract wallets are not supported as direct callers.

## Reporting a vulnerability

Do not publish exploitable details, credentials, wallet data, or user information in a public issue. Contact the repository owner through the verified GitHub account and include minimal reproduction steps without secrets.
