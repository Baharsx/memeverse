// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MemeVerseVault
/// @notice A real ERC-4626 USDC vault on Arc: deposit USDC, hold vault shares, redeem USDC.
/// @dev This vault generates no yield and says so. It runs no strategy, pays no APY, and holds
///      every deposited unit as idle Arc USDC, so one share is worth one unit of USDC minus only
///      the rounding the ERC-4626 standard prescribes. It exists to give MemeVerse a truthful
///      onchain USDC position, not to simulate a farm.
///
///      Deliberate absences, each a class of exploit this vault cannot have:
///        * no owner, admin, pauser, or upgrade path — nobody can drain or freeze user funds;
///        * no fee — no rounding surface for a privileged recipient to farm;
///        * no rebasing or virtual accounting — `totalAssets()` is the contract's real balance.
///
///      Share inflation ("first depositor") is mitigated by OpenZeppelin's virtual shares and
///      assets, amplified here by a decimals offset of 6. The offset sets the attacker's cost of
///      the donation trick: to strand a fraction of a victim's deposit they must first donate
///      roughly 10**6 times that amount and cannot recover it, which makes the attack strictly
///      loss-making. Measured in `MemeVerseVault.test.js`, a 10,000 USDC donation staged against
///      a 1,000 USDC victim deposit costs that victim ~0.0045 USDC — under one basis point, and
///      down from ~0.45% at an offset of 3. All rounding is directed against the user by the
///      standard's own rules, so the vault can never owe more USDC than it holds.
contract MemeVerseVault is ERC4626, ReentrancyGuard {
    error InvalidConfiguration();
    error ZeroAmount();

    constructor(address usdc_)
        ERC20("MemeVerse Vault USDC", "mvUSDC")
        ERC4626(IERC20(usdc_))
    {
        if (usdc_ == address(0)) revert InvalidConfiguration();
        // Fail closed if the configured asset is not the six-decimal Arc USDC interface.
        if (IERC20Metadata(usdc_).decimals() != 6) revert InvalidConfiguration();
    }

    /// @dev Virtual-share offset against inflation donations. Shares are 12-decimal (6 + 6).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @notice Always zero. The vault runs no strategy, so there is no yield to report.
    /// @dev Present so no interface consumer has to invent an APY to display.
    function annualPercentageYieldBps() external pure returns (uint256) {
        return 0;
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        returns (uint256)
    {
        if (shares == 0) revert ZeroAmount();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        if (shares == 0) revert ZeroAmount();
        return super.redeem(shares, receiver, owner);
    }
}
