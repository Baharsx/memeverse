// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MemeVerseSettlement
/// @notice Executes idempotent, operator-authorized creator payouts in Arc USDC.
/// @dev Calls are intended to be forwarded through Arc's Memo contract. Arc's
///      CallFrom extension preserves the signing EOA as msg.sender here.
contract MemeVerseSettlement {
    error AlreadySettled(bytes32 settlementId);
    error InvalidAmount();
    error InvalidConfiguration();
    error InvalidRecipient();
    error TransferFailed();
    error Unauthorized(address caller);

    IERC20 public immutable usdc;
    address public immutable operator;

    mapping(bytes32 settlementId => bool completed) public settled;

    event SettlementExecuted(
        bytes32 indexed settlementId,
        address indexed operator,
        address indexed recipient,
        uint256 amount
    );

    constructor(address operator_, address usdc_) {
        if (operator_ == address(0) || usdc_ == address(0)) revert InvalidConfiguration();
        operator = operator_;
        usdc = IERC20(usdc_);
    }

    function settle(bytes32 settlementId, address recipient, uint256 amount) external {
        if (msg.sender != operator) revert Unauthorized(msg.sender);
        if (settlementId == bytes32(0)) revert InvalidConfiguration();
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();
        if (settled[settlementId]) revert AlreadySettled(settlementId);

        // Mark before the external call. A failed transfer reverts this write.
        settled[settlementId] = true;
        _safeTransferFrom(operator, recipient, amount);

        emit SettlementExecuted(settlementId, operator, recipient, amount);
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }
}
