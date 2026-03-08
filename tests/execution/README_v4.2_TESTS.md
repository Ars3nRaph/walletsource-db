# v4.2 Test Status

## Tests Requiring Rewrite

The following test files were written for the v4.0 BUY/SELL API and need to be completely rewritten for the v4.2 LONG/SHORT leverage strategy:

### Temporarily Disabled (renamed to .old)
- `TradeExecutor.test.ts.old` - Tests for old BUY/SELL/HOLD API
- `../e2e/v4_scenarios.test.ts.old` - End-to-end scenarios with old API

## Changes in v4.2

The TradeExecutor API has been completely refactored:

### Old API (v4.0)
```typescript
interface TradeSignal {
  action: 'BUY' | 'SELL' | 'HOLD' | 'NONE';
  percentage?: number; // Progressive selling
  fallback?: boolean; // PExitCalculator fallback
}
```

### New API (v4.2)
```typescript
interface TradeSignal {
  action: 'LONG' | 'CLOSE_LONG' | 'HOLD_LONG' | 'SHORT' | 'CLOSE_SHORT' | 'HOLD_SHORT' | 'NONE';
  leverage?: number; // 3-5x based on consistency
  entry_mc?: number;
  take_profit?: number;
  stop_loss?: number;
}
```

## New Components to Test

1. **StagnationDetector**
   - Test snapshot buffering (3 snapshots, 30s window)
   - Test stagnation detection (no 5% rise in 20s)
   - Test clear() method

2. **PeakDurationDetector**
   - Test peak detection and tracking
   - Test dump detection (5% drop threshold)
   - Test peak duration calculation (minutes between peak and dump)

3. **PositionManager**
   - Test LONG position opening with leverage
   - Test SHORT position opening with leverage
   - Test take profit detection (2x for LONG, 0.5x for SHORT)
   - Test stop loss detection (stagnation for LONG, +10% for SHORT)
   - Test PnL calculation with leverage

4. **TradeExecutor (v4.2)**
   - Test LONG entry in entry window
   - Test LONG exit on take profit (2x)
   - Test LONG exit on stagnation (no 5% rise in 20s)
   - Test LONG exit on stop loss (-5%)
   - Test SHORT entry after peak with duration confirmation
   - Test SHORT exit on take profit (0.5x)
   - Test SHORT exit on stop loss (+10%)
   - Test SHORT exit on timeout (10 min)
   - Test RIDE-only filtering (consistency >= 0.70)

## TODO

- [ ] Write unit tests for StagnationDetector
- [ ] Write unit tests for PeakDurationDetector
- [ ] Write unit tests for PositionManager
- [ ] Rewrite TradeExecutor tests for LONG/SHORT API
- [ ] Rewrite e2e scenarios for LONG/SHORT strategy
- [ ] Add integration tests for TokenTracker with detectors
- [ ] Add integration tests for PlaybookBuilder with peak_duration_min
