# MemeVerse

**MemeVerse is a meme asset terminal built on Arc Network for launching, trading, minting, and autonomously settling creator activity in USDC.**

The MemeVerse product and visual identity always lead. Arc provides the stablecoin-native infrastructure underneath it:

- **Arc Testnet:** USDC-native gas, pricing, treasury allocation, and agent-driven creator settlement.

## Built on Arc

MemeVerse is designed for two Arc ecosystem tracks:

### DeFi

Meme assets are priced and settled in USDC on Arc. The product models programmable treasury controls, bonding-curve trading, creator revenue splits, and conditional settlement.

### Agentic Economy

The Autonomous Settlement Agent evaluates token traction using explicit signals and policy rules. It can:

1. ingest volume and holder signals;
2. enforce a maximum spend and treasury risk limit;
3. allocate USDC;
4. split settlement between creators and protocol treasury;
5. prepare the approved action for an onchain wallet signature.

The current frontend exposes this decision process as a transparent simulation. The next implementation milestone connects it to Circle Agent Wallets/App Kits for real autonomous USDC settlement.

## Current MVP

- Arc Testnet connection and network switching through MetaMask
- Arc Testnet configuration with USDC-denominated gas
- Network-aware launch, trade, explorer, fee, and settlement interfaces
- Meme-token launch form and live receive calculation
- Bonding-curve trading terminal
- NFT archive, mint, listing modal, and asset vault
- Autonomous settlement policy simulator with execution trace
- Responsive tactile-brutalist interface

## Network Configuration

| Network | Chain ID | Native currency | RPC | Explorer |
|---|---:|---|---|---|
| Arc Testnet | `5042002` | USDC | `https://rpc.testnet.arc.network` | `https://testnet.arcscan.app` |

Arc Testnet USDC contract: `0x3600000000000000000000000000000000000000`

## Stack

- React + Vite
- wagmi + viem
- TanStack Query
- MetaMask injected connector
- Arc Testnet
- Circle USDC architecture

## Run Locally

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
npm run preview
```

## Arc Brand Compliance

MemeVerse is an independent product built on Arc Network. References to Arc describe the infrastructure and do not imply that MemeVerse is an official Arc or Circle product, endorsement, or partnership.

- The product name, app identity, logo, icon, and visual system remain exclusively MemeVerse.
- Public product copy uses descriptive language such as **Built on Arc**, **Available on Arc**, or **Deploy on Arc**.
- Arc is not incorporated into the MemeVerse product name, company name, app icon, or logo system.
- The repository currently contains no Arc logo asset; all bundled marks are original MemeVerse assets.
- If an Arc logo is added later, use only the latest approved asset from the [Circle Brand Kit](https://www.circle.com/pressroom), without recoloring, distortion, recreation, overlays, or effects.
- Any future Arc logo must retain the official clear space, render at least 50px high digitally, and remain less prominent than the MemeVerse logo.
- Co-marketing, paid media, partner launches, or materials that could imply endorsement require a fresh review against the [Arc Brand Guidelines and Partner Toolkit](https://www.arc.io/brand-guidelines-and-partner-toolkit) and any necessary approval.

## Arc House and Architects

Architects is a personal community role administered outside this repository; it does not establish a partnership, agency, or endorsement relationship with Circle. Participating maintainers should keep their Discord username current in their Arc House profile so manually administered role updates can be matched correctly. No Arc House credentials or personal Discord identifiers belong in this repository.

## Roadmap to Final Submission

- Deploy launch, bonding-curve, treasury, and settlement contracts on Arc
- Integrate Circle App Kits for Send/Swap/Bridge or Unified Balance where applicable
- Connect the settlement agent to a Circle wallet and real USDC transfers
- Persist token, NFT, listing, and policy state from onchain events
- Add transaction history, risk monitoring, and public demo data

## Design

MemeVerse uses a **Tactile Brutalist Degen Terminal** system: hard 1px borders, flat surfaces, mono data, acid-lime state accents, zero gradients, and a custom vector coin mark.

## License

MIT
