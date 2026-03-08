#!/bin/bash

# Watch paper trades in real-time
if [ ! -f "data/paper-trades.log" ]; then
  echo "No paper trades yet. Waiting for verdicts..."
  exit 0
fi

echo "=== Paper Trades (Real-time) ==="
echo ""
echo "Press Ctrl+C to stop"
echo ""

tail -f data/paper-trades.log | while read line; do
  # Parse JSON and format output
  timestamp=$(echo $line | jq -r '.timestamp' 2>/dev/null)
  token=$(echo $line | jq -r '.token' 2>/dev/null | cut -c1-12)
  action=$(echo $line | jq -r '.action' 2>/dev/null)
  confidence=$(echo $line | jq -r '.confidence' 2>/dev/null)
  percentage=$(echo $line | jq -r '.percentage' 2>/dev/null)
  strategy=$(echo $line | jq -r '.strategy' 2>/dev/null)
  reason=$(echo $line | jq -r '.reason' 2>/dev/null)

  # Color based on action
  case $action in
    BUY)
      color='\033[0;32m' # Green
      ;;
    SELL)
      color='\033[0;31m' # Red
      ;;
    SHORT)
      color='\033[0;33m' # Yellow
      ;;
    COVER)
      color='\033[0;36m' # Cyan
      ;;
    HOLD*)
      color='\033[0;34m' # Blue
      ;;
    *)
      color='\033[0m' # Default
      ;;
  esac

  nc='\033[0m' # No color

  echo -e "${timestamp} | ${color}${action}${nc} | Token: ${token}... | ${strategy} | Conf: ${confidence} | ${percentage}% | ${reason}"
done
