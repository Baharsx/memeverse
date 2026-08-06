// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMemeVerseFactory {
    function isMarket(address market) external view returns (bool);
}

interface IMemeMarket {
    function creator() external view returns (address);
    function symbol() external view returns (string memory);
}

/// @title MemeVerseMediaNFT
/// @notice ERC-721 meme media assets whose MemeVerse market provenance is proven at mint time.
/// @dev Provenance is established from onchain state only, never from caller-supplied claims:
///      the market must be registered in the immutable trusted factory, and `msg.sender` must be
///      that market's own `creator()`. A browser therefore cannot mint an asset claiming
///      association with a market it does not own, and there is no privileged or owner mint path.
///
///      `contentHash` is the keccak256 digest of the exact media bytes the metadata describes.
///      It is unique across the collection, so the same media can never be minted twice, and the
///      digest is recomputable offchain from the referenced asset.
contract MemeVerseMediaNFT is ERC721URIStorage {
    error ContentAlreadyMinted(bytes32 contentHash, uint256 tokenId);
    error InvalidConfiguration();
    error InvalidContentHash();
    error InvalidMetadataUri();
    error MarketNotRegistered(address market);
    error NotMarketCreator(address market, address caller);

    /// @notice The only factory whose markets may be referenced by this collection.
    IMemeVerseFactory public immutable factory;

    struct Provenance {
        address creator;
        address market;
        bytes32 contentHash;
        uint64 mintedAtBlock;
        uint64 mintedAt;
    }

    uint256 public totalMinted;

    mapping(uint256 tokenId => Provenance provenance) private _provenance;
    mapping(bytes32 contentHash => uint256 tokenId) public tokenIdForContentHash;

    event MediaMinted(
        uint256 indexed tokenId,
        address indexed creator,
        address indexed market,
        bytes32 contentHash,
        string metadataUri,
        uint256 mintedAtBlock
    );

    constructor(address factory_) ERC721("MemeVerse Media", "MVMEDIA") {
        if (factory_ == address(0)) revert InvalidConfiguration();
        factory = IMemeVerseFactory(factory_);
    }

    /// @notice Mints a media asset bound to a MemeVerse market the caller provably created.
    /// @param market A market registered in the trusted factory whose `creator()` is the caller.
    /// @param contentHash keccak256 of the exact media bytes referenced by `metadataUri`.
    function mint(address market, bytes32 contentHash, string calldata metadataUri)
        external
        returns (uint256 tokenId)
    {
        if (contentHash == bytes32(0)) revert InvalidContentHash();
        if (bytes(metadataUri).length == 0) revert InvalidMetadataUri();
        // Registration is checked against the immutable factory, so an arbitrary contract that
        // merely implements `creator()` cannot pose as a MemeVerse market.
        if (!factory.isMarket(market)) revert MarketNotRegistered(market);
        address marketCreator = IMemeMarket(market).creator();
        if (marketCreator != msg.sender) revert NotMarketCreator(market, msg.sender);

        uint256 existing = tokenIdForContentHash[contentHash];
        if (existing != 0) revert ContentAlreadyMinted(contentHash, existing);

        unchecked {
            tokenId = ++totalMinted;
        }
        tokenIdForContentHash[contentHash] = tokenId;
        _provenance[tokenId] = Provenance({
            creator: msg.sender,
            market: market,
            contentHash: contentHash,
            mintedAtBlock: uint64(block.number),
            mintedAt: uint64(block.timestamp)
        });

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, metadataUri);

        emit MediaMinted(tokenId, msg.sender, market, contentHash, metadataUri, block.number);
    }

    /// @notice Immutable provenance recorded when the asset was minted.
    function provenanceOf(uint256 tokenId) external view returns (Provenance memory) {
        _requireOwned(tokenId);
        return _provenance[tokenId];
    }
}

/// @title MemeVerseNFTMarketplace
/// @notice Fixed-price MemeVerse media sales settled exclusively in Arc USDC.
/// @dev Deliberately fee-free. A marketplace cut would add rounding surface and a privileged
///      recipient without improving the product, so a sale moves exactly the listed price from
///      buyer to seller. The contract never holds USDC or NFTs and exposes no withdrawal surface,
///      so there is nothing for an administrator to drain — there is no administrator.
contract MemeVerseNFTMarketplace is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error InvalidPrice();
    error ListingNotFound(uint256 tokenId);
    error MarketplaceNotApproved(uint256 tokenId);
    error NotListingSeller(uint256 tokenId, address caller);
    error NotTokenOwner(uint256 tokenId, address caller);
    error SellerNoLongerOwner(uint256 tokenId, address seller);
    error SellerCannotBuy(uint256 tokenId);

    IERC721 public immutable nft;
    IERC20 public immutable usdc;

    struct Listing {
        address seller;
        uint256 priceUsdc;
        uint64 listedAt;
    }

    mapping(uint256 tokenId => Listing listing) public listings;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 priceUsdc);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 priceUsdc
    );

    constructor(address nft_, address usdc_) {
        if (nft_ == address(0) || usdc_ == address(0)) revert InvalidConfiguration();
        nft = IERC721(nft_);
        usdc = IERC20(usdc_);
    }

    /// @notice Lists a token the caller owns for an exact six-decimal USDC price.
    function list(uint256 tokenId, uint256 priceUsdc) external {
        if (priceUsdc == 0) revert InvalidPrice();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId, msg.sender);
        if (nft.getApproved(tokenId) != address(this)
            && !nft.isApprovedForAll(msg.sender, address(this))) {
            revert MarketplaceNotApproved(tokenId);
        }
        listings[tokenId] = Listing({
            seller: msg.sender,
            priceUsdc: priceUsdc,
            listedAt: uint64(block.timestamp)
        });
        emit Listed(tokenId, msg.sender, priceUsdc);
    }

    function cancel(uint256 tokenId) external {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert ListingNotFound(tokenId);
        if (listing.seller != msg.sender) revert NotListingSeller(tokenId, msg.sender);
        delete listings[tokenId];
        emit ListingCancelled(tokenId, msg.sender);
    }

    /// @notice Buys a listed token for exactly the listed USDC price.
    /// @dev The listing is consumed before any external call, so it can be filled at most once
    ///      even if the buyer or the token contract attempts to re-enter. A listing whose seller
    ///      no longer owns the token, or who has revoked approval, is rejected rather than
    ///      silently repriced or executed against the wrong owner.
    function buy(uint256 tokenId) external nonReentrant {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert ListingNotFound(tokenId);
        if (listing.seller == msg.sender) revert SellerCannotBuy(tokenId);

        address currentOwner = nft.ownerOf(tokenId);
        if (currentOwner != listing.seller) revert SellerNoLongerOwner(tokenId, listing.seller);
        if (nft.getApproved(tokenId) != address(this)
            && !nft.isApprovedForAll(listing.seller, address(this))) {
            revert MarketplaceNotApproved(tokenId);
        }

        // Effects before interactions: the listing cannot be replayed by a reentrant caller.
        delete listings[tokenId];

        // Exactly the listed price, straight from buyer to seller. SafeERC20 reverts atomically
        // on a false-returning or non-compliant token, so no NFT moves without payment.
        usdc.safeTransferFrom(msg.sender, listing.seller, listing.priceUsdc);
        nft.safeTransferFrom(listing.seller, msg.sender, tokenId);

        emit Sold(tokenId, listing.seller, msg.sender, listing.priceUsdc);
    }

    /// @notice Whether a listing can be filled right now, for honest UI quoting.
    function isFillable(uint256 tokenId) external view returns (bool) {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) return false;
        if (nft.ownerOf(tokenId) != listing.seller) return false;
        return nft.getApproved(tokenId) == address(this)
            || nft.isApprovedForAll(listing.seller, address(this));
    }
}
