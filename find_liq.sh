#!/bin/bash
LATEST=$(cast block-number --rpc-url https://eth.merkle.io)
END=$LATEST
for i in {1..20}; do
  START=$((END - 1000))
  echo "Scanning $START to $END..."
  RES=$(cast logs --rpc-url https://eth.merkle.io --address 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 "LiquidationCall(address,address,address,uint256,uint256,address,bool)" --from-block $START --to-block $END)
  if [[ "$RES" != *"[]"* && "$RES" != "" ]]; then
    echo "Found!"
    echo "$RES" | grep -A 5 'blockNumber'
    exit 0
  fi
  END=$START
done
