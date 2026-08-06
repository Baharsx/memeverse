// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarketplaceUnderAttack {
    function buy(uint256 tokenId) external;
    function list(uint256 tokenId, uint256 priceUsdc) external;
}

interface IVaultUnderAttack {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);
}

interface IERC721Minimal {
    function setApprovalForAll(address operator, bool approved) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice A contract that satisfies `creator()` but was never registered by the trusted factory.
/// @dev Used to prove that MemeVerse media provenance is anchored to factory registration, not to
///      the mere presence of a `creator()` function on some arbitrary address.
contract SpoofedMemeMarket {
    address public creator;

    constructor(address creator_) {
        creator = creator_;
    }

    function symbol() external pure returns (string memory) {
        return "SPOOF";
    }
}

/// @notice Attempts to fill the same listing twice by re-entering from `onERC721Received`.
contract ReentrantNftBuyer {
    IMarketplaceUnderAttack public immutable marketplace;
    uint256 public reentryAttempts;
    bool private attacking;

    constructor(address marketplace_) {
        marketplace = IMarketplaceUnderAttack(marketplace_);
    }

    function approveUsdc(address usdc, uint256 amount) external {
        IERC20Minimal(usdc).approve(address(marketplace), amount);
    }

    function attack(uint256 tokenId) external {
        attacking = true;
        marketplace.buy(tokenId);
        attacking = false;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        returns (bytes4)
    {
        if (attacking) {
            reentryAttempts += 1;
            // Must revert the whole transaction if the guard is missing; if the guard holds this
            // call reverts and is swallowed, leaving the single legitimate fill intact.
            try marketplace.buy(tokenId) {} catch {}
        }
        return this.onERC721Received.selector;
    }
}

/// @notice Re-enters the vault from a token callback fired mid-deposit.
contract ReentrantVaultDepositor {
    IVaultUnderAttack public immutable vault;
    uint256 public reentryAttempts;
    bool public reentryReverted;

    constructor(address vault_) {
        vault = IVaultUnderAttack(vault_);
    }

    function approveAsset(address usdc, uint256 amount) external {
        IERC20Minimal(usdc).approve(address(vault), amount);
    }

    function deposit(uint256 assets) external {
        vault.deposit(assets, address(this));
    }

    /// @dev Invoked by MockUSDC's transfer callback while the vault's deposit is mid-flight.
    function reenter(uint256 assets) external {
        reentryAttempts += 1;
        try vault.deposit(assets, address(this)) {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }
}
