#!/bin/bash
USER="0xbc90243806b018e5e75930cfcccfb3230d6d226c"
POOL="0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
AMOUNT="100000000" # 100 USDC

echo "Impersonating $USER..."
cast rpc anvil_impersonateAccount $USER

echo "Sending Borrow Tx for $USER..."
cast send $POOL "borrow(address,uint256,uint256,uint16,address)" $USDC $AMOUNT 2 0 $USER --unlocked --from $USER

echo "Done!"
