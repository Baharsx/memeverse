// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackEnabled;
    bool public failTransfers;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setCallback(address target, bytes calldata data, bool enabled) external {
        callbackTarget = target;
        callbackData = data;
        callbackEnabled = enabled;
    }

    function setFailTransfers(bool enabled) external {
        failTransfers = enabled;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "ALLOWANCE");
        allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount);
        if (callbackEnabled) {
            (bool success,) = callbackTarget.call(callbackData);
            require(success, "CALLBACK");
        }
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "RECIPIENT");
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
