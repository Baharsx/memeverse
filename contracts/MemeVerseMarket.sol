// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20MarketCurrency {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MemeMarket
/// @notice A fixed-supply ERC-20 meme asset with an integral linear USDC bonding curve.
/// @dev Prices and accounting use the six-decimal Arc USDC ERC-20 interface. The MVP curve
///      trades whole tokens only; ERC-20 transfers can still move fractional token units.
contract MemeMarket {
    error AmountMustBeWholeTokens();
    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidAmount();
    error InvalidRecipient();
    error Reentrancy();
    error SlippageExceeded(uint256 minimum, uint256 actual);
    error TransferFailed();

    uint8 public constant decimals = 18;
    uint256 public constant TOKEN_UNIT = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    string public name;
    string public symbol;
    string public description;
    uint256 public immutable totalSupply;
    uint256 public immutable totalSupplyTokens;
    address public immutable creator;
    address public immutable treasury;
    IERC20MarketCurrency public immutable usdc;
    uint16 public immutable creatorFeeBps;
    uint16 public immutable treasuryFeeBps;
    uint256 public immutable basePriceUsdc;
    uint256 public immutable slopePriceUsdc;
    uint256 public immutable createdAt;
    uint256 public immutable createdBlock;
    bool public constant active = true;

    uint256 public soldTokenCount;
    uint256 public reserveUsdc;
    uint256 public creatorFeesPaidUsdc;
    uint256 public treasuryFeesPaidUsdc;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    uint256 private unlocked = 1;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Bought(
        address indexed buyer,
        uint256 usdcIn,
        uint256 tokenOut,
        uint256 curveCostUsdc,
        uint256 creatorFeeUsdc,
        uint256 treasuryFeeUsdc,
        uint256 soldTokenCount
    );
    event Sold(
        address indexed seller,
        uint256 tokenIn,
        uint256 usdcOut,
        uint256 grossCurveReturnUsdc,
        uint256 creatorFeeUsdc,
        uint256 treasuryFeeUsdc,
        uint256 soldTokenCount
    );

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(
        address creator_,
        address treasury_,
        address usdc_,
        string memory name_,
        string memory symbol_,
        string memory description_,
        uint256 totalSupplyTokens_,
        uint256 basePriceUsdc_,
        uint256 slopePriceUsdc_,
        uint16 creatorFeeBps_,
        uint16 treasuryFeeBps_
    ) {
        creator = creator_;
        treasury = treasury_;
        usdc = IERC20MarketCurrency(usdc_);
        name = name_;
        symbol = symbol_;
        description = description_;
        totalSupplyTokens = totalSupplyTokens_;
        totalSupply = totalSupplyTokens_ * TOKEN_UNIT;
        basePriceUsdc = basePriceUsdc_;
        slopePriceUsdc = slopePriceUsdc_;
        creatorFeeBps = creatorFeeBps_;
        treasuryFeeBps = treasuryFeeBps_;
        createdAt = block.timestamp;
        createdBlock = block.number;
        balanceOf[address(this)] = totalSupply;
        emit Transfer(address(0), address(this), totalSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (to == address(this)) revert InvalidRecipient();
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (to == address(this)) revert InvalidRecipient();
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            if (approved < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = approved - amount;
            emit Approval(from, msg.sender, approved - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    /// @notice Cumulative six-decimal USDC cost for the first `tokenCount` whole tokens.
    /// @dev C(q) = base*q + slope*q*(q-1)/(2*(T-1)), rounded down.
    function cumulativeCurveCost(uint256 tokenCount) public view returns (uint256) {
        if (tokenCount > totalSupplyTokens) revert InvalidAmount();
        uint256 linear = basePriceUsdc * tokenCount;
        uint256 curve = (slopePriceUsdc * tokenCount * (tokenCount - (tokenCount == 0 ? 0 : 1)))
            / (2 * (totalSupplyTokens - 1));
        return linear + curve;
    }

    function spotPriceUsdc() external view returns (uint256) {
        if (soldTokenCount == totalSupplyTokens) return 0;
        return cumulativeCurveCost(soldTokenCount + 1) - cumulativeCurveCost(soldTokenCount);
    }

    function quoteBuy(uint256 usdcIn)
        public
        view
        returns (
            uint256 tokenOut,
            uint256 curveCostUsdc,
            uint256 creatorFeeUsdc,
            uint256 treasuryFeeUsdc
        )
    {
        creatorFeeUsdc = (usdcIn * creatorFeeBps) / BPS_DENOMINATOR;
        treasuryFeeUsdc = (usdcIn * treasuryFeeBps) / BPS_DENOMINATOR;
        uint256 curveBudget = usdcIn - creatorFeeUsdc - treasuryFeeUsdc;
        uint256 available = totalSupplyTokens - soldTokenCount;
        uint256 low;
        uint256 high = available;
        uint256 startCost = cumulativeCurveCost(soldTokenCount);

        while (low < high) {
            uint256 middle = low + (high - low + 1) / 2;
            uint256 cost = cumulativeCurveCost(soldTokenCount + middle) - startCost;
            if (cost <= curveBudget) low = middle;
            else high = middle - 1;
        }

        tokenOut = low * TOKEN_UNIT;
        curveCostUsdc = cumulativeCurveCost(soldTokenCount + low) - startCost;
    }

    function quoteSell(uint256 tokenIn)
        public
        view
        returns (
            uint256 usdcOut,
            uint256 grossCurveReturnUsdc,
            uint256 creatorFeeUsdc,
            uint256 treasuryFeeUsdc
        )
    {
        if (tokenIn == 0 || tokenIn % TOKEN_UNIT != 0) return (0, 0, 0, 0);
        uint256 tokenCount = tokenIn / TOKEN_UNIT;
        if (tokenCount > soldTokenCount) return (0, 0, 0, 0);
        grossCurveReturnUsdc = cumulativeCurveCost(soldTokenCount)
            - cumulativeCurveCost(soldTokenCount - tokenCount);
        creatorFeeUsdc = (grossCurveReturnUsdc * creatorFeeBps) / BPS_DENOMINATOR;
        treasuryFeeUsdc = (grossCurveReturnUsdc * treasuryFeeBps) / BPS_DENOMINATOR;
        usdcOut = grossCurveReturnUsdc - creatorFeeUsdc - treasuryFeeUsdc;
    }

    function buy(uint256 usdcIn, uint256 minimumTokenOut)
        external
        nonReentrant
        returns (uint256 tokenOut)
    {
        if (usdcIn == 0) revert InvalidAmount();
        uint256 curveCost;
        uint256 creatorFee;
        uint256 treasuryFee;
        (tokenOut, curveCost, creatorFee, treasuryFee) = quoteBuy(usdcIn);
        if (tokenOut == 0) revert InvalidAmount();
        if (tokenOut < minimumTokenOut) revert SlippageExceeded(minimumTokenOut, tokenOut);

        _safeTransferFrom(address(usdc), msg.sender, address(this), usdcIn);
        uint256 tokenCount = tokenOut / TOKEN_UNIT;
        soldTokenCount += tokenCount;
        reserveUsdc += curveCost;
        creatorFeesPaidUsdc += creatorFee;
        treasuryFeesPaidUsdc += treasuryFee;
        _transfer(address(this), msg.sender, tokenOut);
        _distributeFees(creatorFee, treasuryFee);

        emit Bought(
            msg.sender,
            usdcIn,
            tokenOut,
            curveCost,
            creatorFee,
            treasuryFee,
            soldTokenCount
        );
    }

    function sell(uint256 tokenIn, uint256 minimumUsdcOut)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (tokenIn == 0) revert InvalidAmount();
        if (tokenIn % TOKEN_UNIT != 0) revert AmountMustBeWholeTokens();
        uint256 grossReturn;
        uint256 creatorFee;
        uint256 treasuryFee;
        (usdcOut, grossReturn, creatorFee, treasuryFee) = quoteSell(tokenIn);
        if (grossReturn == 0 || grossReturn > reserveUsdc) revert InvalidAmount();
        if (usdcOut < minimumUsdcOut) revert SlippageExceeded(minimumUsdcOut, usdcOut);

        _transfer(msg.sender, address(this), tokenIn);
        soldTokenCount -= tokenIn / TOKEN_UNIT;
        reserveUsdc -= grossReturn;
        creatorFeesPaidUsdc += creatorFee;
        treasuryFeesPaidUsdc += treasuryFee;
        _safeTransfer(address(usdc), msg.sender, usdcOut);
        _distributeFees(creatorFee, treasuryFee);

        emit Sold(
            msg.sender,
            tokenIn,
            usdcOut,
            grossReturn,
            creatorFee,
            treasuryFee,
            soldTokenCount
        );
    }

    function _distributeFees(uint256 creatorFee, uint256 treasuryFee) private {
        if (creatorFee != 0) _safeTransfer(address(usdc), creator, creatorFee);
        if (treasuryFee != 0) _safeTransfer(address(usdc), treasury, treasuryFee);
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidRecipient();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IERC20MarketCurrency.transfer, (to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IERC20MarketCurrency.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}

/// @title MemeVerseFactory
/// @notice Immutable registry and deployer for Arc Testnet MemeVerse markets.
contract MemeVerseFactory {
    error DuplicateMarket();
    error InvalidConfiguration();
    error InvalidMarketParameters();

    uint16 public constant MAX_TOTAL_FEE_BPS = 500;
    uint256 public constant MIN_SUPPLY_TOKENS = 100;
    uint256 public constant MAX_SUPPLY_TOKENS = 1_000_000_000;
    uint256 public constant MAX_PRICE_USDC = 1_000_000_000; // 1,000 USDC at six decimals.

    address public immutable usdc;
    address public immutable treasury;
    uint16 public immutable creatorFeeBps;
    uint16 public immutable treasuryFeeBps;
    uint256 public immutable deployedAtBlock;

    address[] public markets;
    mapping(bytes32 creatorSymbolKey => address market) public marketFor;
    mapping(address market => bool registered) public isMarket;

    event MarketCreated(
        address indexed market,
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupplyTokens,
        uint256 basePriceUsdc,
        uint256 slopePriceUsdc,
        uint256 createdAt,
        uint256 createdBlock
    );

    constructor(address usdc_, address treasury_, uint16 creatorFeeBps_, uint16 treasuryFeeBps_) {
        if (usdc_ == address(0) || treasury_ == address(0)) revert InvalidConfiguration();
        if (uint256(creatorFeeBps_) + treasuryFeeBps_ > MAX_TOTAL_FEE_BPS) {
            revert InvalidConfiguration();
        }
        usdc = usdc_;
        treasury = treasury_;
        creatorFeeBps = creatorFeeBps_;
        treasuryFeeBps = treasuryFeeBps_;
        deployedAtBlock = block.number;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function createMarket(
        string calldata name,
        string calldata symbol,
        string calldata description,
        uint256 totalSupplyTokens,
        uint256 basePriceUsdc,
        uint256 slopePriceUsdc
    ) external returns (address market) {
        uint256 nameLength = bytes(name).length;
        uint256 symbolLength = bytes(symbol).length;
        if (
            nameLength == 0 || nameLength > 64 || symbolLength == 0 || symbolLength > 10
                || bytes(description).length > 280 || totalSupplyTokens < MIN_SUPPLY_TOKENS
                || totalSupplyTokens > MAX_SUPPLY_TOKENS || basePriceUsdc == 0
                || basePriceUsdc > MAX_PRICE_USDC || slopePriceUsdc > MAX_PRICE_USDC
        ) revert InvalidMarketParameters();

        bytes32 key = keccak256(abi.encode(msg.sender, keccak256(bytes(symbol))));
        if (marketFor[key] != address(0)) revert DuplicateMarket();

        MemeMarket deployed = new MemeMarket(
            msg.sender,
            treasury,
            usdc,
            name,
            symbol,
            description,
            totalSupplyTokens,
            basePriceUsdc,
            slopePriceUsdc,
            creatorFeeBps,
            treasuryFeeBps
        );
        market = address(deployed);
        marketFor[key] = market;
        isMarket[market] = true;
        markets.push(market);

        emit MarketCreated(
            market,
            market,
            msg.sender,
            name,
            symbol,
            totalSupplyTokens,
            basePriceUsdc,
            slopePriceUsdc,
            block.timestamp,
            block.number
        );
    }
}
