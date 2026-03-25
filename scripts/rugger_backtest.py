#!/usr/bin/env python3
"""
Rugger Strategy Backtester — Walk-Forward
==========================================
For each rugger wallet with 10+ tokens:
  - TRAINING: first 10 tokens → build wallet profile (median peak, P25 peak, avg time-to-rug)
  - TEST: all subsequent tokens → apply strategy, measure PnL

Entry: at detection (fdv_at_detection or ~2500 default)
Exit: target = P25 of training peak_mc (conservative — 75% of tokens reach this)
      time_stop = avg_time_to_rug from training * 0.8 (safety margin)
      hard_stop = -35% (same as v10.10h)
If peak >= target → WIN at target PnL
If peak < target but > entry → partial win (exit at 50% of peak due to rug slippage)
If peak < entry → LOSS (hard stop or rug gap)

Fees: 4.5% round-trip
Position: 10% of wallet per trade
"""

import psycopg2
import json
from collections import defaultdict

conn = psycopg2.connect(
    host='localhost', dbname='walletsource', 
    user='walletsource', password='walletsource_dev'
)
cur = conn.cursor()

# Get all rugger wallets with their tokens ordered by detection time
cur.execute("""
    SELECT t.creator_wallet, t.token_address, t.detected_at,
           t.fdv_at_detection, t.peak_mc, t.time_to_peak_min, 
           t.time_to_rug_min, t.verdict
    FROM token_events t
    JOIN wallet_profiles w ON w.wallet_address = t.creator_wallet
    WHERE w.rug_count >= 5
      AND t.peak_mc IS NOT NULL AND t.peak_mc > 0
    ORDER BY t.creator_wallet, t.detected_at
""")

# Group by wallet
wallets = defaultdict(list)
for row in cur.fetchall():
    wallets[row[0]].append({
        'token': row[1], 'detected_at': row[2],
        'entry_mc': row[3] or 2500, 'peak_mc': row[4],
        'ttp': row[5] or 0, 'ttr': row[6] or 5, 'verdict': row[7]
    })

FEES = 0.045
HARD_STOP = -0.35
MIN_TRAIN = 10
POS_SIZE = 0.10

results = {
    'total_wallets': 0, 'total_trades': 0,
    'wins': 0, 'losses': 0,
    'pnls': [], 'wallet_results': [],
    'by_cv': {'low': [], 'med': [], 'high': []},
    'exit_types': defaultdict(int),
}

wallet_details = []

for wallet_addr, tokens in wallets.items():
    if len(tokens) < MIN_TRAIN + 1:
        continue
    
    results['total_wallets'] += 1
    
    # Training set: first 10 tokens
    train = tokens[:MIN_TRAIN]
    test = tokens[MIN_TRAIN:]
    
    # Build profile from training
    train_peaks = [t['peak_mc'] for t in train]
    train_peaks.sort()
    
    median_peak = train_peaks[len(train_peaks)//2]
    p25_peak = train_peaks[int(len(train_peaks)*0.25)]
    avg_peak = sum(train_peaks) / len(train_peaks)
    std_peak = (sum((p - avg_peak)**2 for p in train_peaks) / len(train_peaks)) ** 0.5
    cv_peak = std_peak / max(avg_peak, 1)
    
    train_ttrs = [t['ttr'] for t in train if t['ttr'] and t['ttr'] > 0]
    avg_ttr = sum(train_ttrs) / max(len(train_ttrs), 1)
    
    # Strategy params from training
    target_exit_mc = p25_peak  # Conservative: 75% should reach this
    time_stop_min = avg_ttr * 0.8  # Exit before avg rug time
    
    # Skip wallets with too-low peaks (not profitable after fees)
    min_profit_mc = 2500 * (1 + FEES + 0.05)  # Need at least 10% gross to cover fees
    if target_exit_mc < min_profit_mc:
        continue
    
    # Test set: apply strategy
    w_trades = 0
    w_wins = 0
    w_pnls = []
    
    for t in test:
        entry_mc = t['entry_mc']
        peak_mc = t['peak_mc']
        
        # Can we reach target?
        if peak_mc >= target_exit_mc:
            # WIN — exit at target
            pnl_gross = (target_exit_mc - entry_mc) / max(entry_mc, 1)
            exit_type = 'TARGET'
        elif peak_mc > entry_mc * 1.05:
            # Partial — peak above entry but below target, rug catches us
            # Assume we exit at ~60% of peak (rug slippage)
            exit_mc = peak_mc * 0.6
            pnl_gross = (exit_mc - entry_mc) / max(entry_mc, 1)
            exit_type = 'RUG_PARTIAL'
        else:
            # LOSS — token never pumped or rugged fast
            # Hard stop or rug gap
            pnl_gross = max(HARD_STOP, (peak_mc * 0.5 - entry_mc) / max(entry_mc, 1))
            exit_type = 'RUG_LOSS'
        
        pnl_net = pnl_gross - FEES
        
        w_trades += 1
        w_pnls.append(pnl_net)
        results['pnls'].append(pnl_net)
        results['exit_types'][exit_type] += 1
        
        if pnl_net > 0:
            w_wins += 1
            results['wins'] += 1
        else:
            results['losses'] += 1
        
        results['total_trades'] += 1
    
    if w_trades == 0:
        continue
    
    # Wallet simulation
    wallet_sol = 10.0
    for pnl in w_pnls:
        wallet_sol *= (1 + pnl * POS_SIZE)
    
    w_wr = w_wins / w_trades * 100
    w_avg_pnl = sum(w_pnls) / len(w_pnls) * 100
    
    cv_bucket = 'low' if cv_peak < 0.3 else ('med' if cv_peak < 0.6 else 'high')
    results['by_cv'][cv_bucket].extend(w_pnls)
    
    wallet_details.append({
        'wallet': wallet_addr[:12],
        'train_tokens': MIN_TRAIN,
        'test_tokens': w_trades,
        'cv_peak': cv_peak,
        'target_mc': int(target_exit_mc),
        'time_stop': round(time_stop_min, 1),
        'wr': round(w_wr, 1),
        'avg_pnl': round(w_avg_pnl, 1),
        'wallet_sol': round(wallet_sol, 2),
        'cv_bucket': cv_bucket,
    })

# Sort by wallet performance
wallet_details.sort(key=lambda x: x['wallet_sol'], reverse=True)

# Print report
print("=" * 80)
print("RUGGER STRATEGY BACKTEST — Walk-Forward (Train 10 / Test Rest)")
print("=" * 80)

total = results['total_trades']
wins = results['wins']
wr = wins / max(total, 1) * 100
avg_pnl = sum(results['pnls']) / max(len(results['pnls']), 1) * 100
med_pnl = sorted(results['pnls'])[len(results['pnls'])//2] * 100 if results['pnls'] else 0

# Wallet sim overall
overall_wallet = 10.0
for p in results['pnls']:
    overall_wallet *= (1 + p * POS_SIZE)

print(f"\nWallets analyzed:  {results['total_wallets']}")
print(f"Wallets tradeable: {len(wallet_details)} (target > entry + fees)")
print(f"Total test trades: {total}")
print(f"Win rate:          {wr:.1f}%")
print(f"Avg PnL (net):     {avg_pnl:+.1f}%")
print(f"Median PnL (net):  {med_pnl:+.1f}%")
print(f"Wallet 10→:        {overall_wallet:.2f} SOL")

print(f"\n--- Exit Types ---")
for etype, cnt in sorted(results['exit_types'].items(), key=lambda x: -x[1]):
    pct = cnt / max(total, 1) * 100
    print(f"  {etype:15s}  {cnt:5d}  ({pct:.1f}%)")

print(f"\n--- By Predictability (CV of peak MC) ---")
for bucket, label in [('low', 'CV < 30% (very predictable)'), ('med', 'CV 30-60%'), ('high', 'CV > 60%')]:
    pnls = results['by_cv'][bucket]
    if not pnls:
        print(f"  {label:35s}  no trades")
        continue
    bwr = sum(1 for p in pnls if p > 0) / len(pnls) * 100
    bavg = sum(pnls) / len(pnls) * 100
    bwallet = 10.0
    for p in pnls:
        bwallet *= (1 + p * POS_SIZE)
    print(f"  {label:35s}  N={len(pnls):5d}  WR={bwr:.0f}%  avg={bavg:+.1f}%  wallet={bwallet:.2f}")

print(f"\n--- Top 20 Wallets (by final SOL) ---")
print(f"{'Wallet':<14s} {'Test':>4s} {'CV':>5s} {'Target':>7s} {'TStop':>5s} {'WR':>5s} {'Avg':>6s} {'Wallet':>8s}")
print("-" * 60)
for w in wallet_details[:20]:
    print(f"{w['wallet']:<14s} {w['test_tokens']:>4d} {w['cv_peak']:>5.2f} {w['target_mc']:>7d} {w['time_stop']:>5.1f} {w['wr']:>4.0f}% {w['avg_pnl']:>+5.1f}% {w['wallet_sol']:>7.2f}")

print(f"\n--- Bottom 10 Wallets ---")
print(f"{'Wallet':<14s} {'Test':>4s} {'CV':>5s} {'Target':>7s} {'TStop':>5s} {'WR':>5s} {'Avg':>6s} {'Wallet':>8s}")
print("-" * 60)
for w in wallet_details[-10:]:
    print(f"{w['wallet']:<14s} {w['test_tokens']:>4d} {w['cv_peak']:>5.2f} {w['target_mc']:>7d} {w['time_stop']:>5.1f} {w['wr']:>4.0f}% {w['avg_pnl']:>+5.1f}% {w['wallet_sol']:>7.2f}")

# Profitable vs unprofitable wallets
profitable = [w for w in wallet_details if w['wallet_sol'] > 10]
losing = [w for w in wallet_details if w['wallet_sol'] <= 10]
print(f"\n--- Summary ---")
print(f"Profitable wallets: {len(profitable)}/{len(wallet_details)} ({len(profitable)/max(len(wallet_details),1)*100:.0f}%)")
print(f"Losing wallets:     {len(losing)}/{len(wallet_details)}")
if profitable:
    print(f"Avg wallet (profitable): {sum(w['wallet_sol'] for w in profitable)/len(profitable):.2f} SOL")
if losing:
    print(f"Avg wallet (losing):     {sum(w['wallet_sol'] for w in losing)/len(losing):.2f} SOL")

# How many tokens/day do these wallets create?
cur.execute("""
    SELECT COUNT(*) as tokens_24h
    FROM token_events t
    JOIN wallet_profiles w ON w.wallet_address = t.creator_wallet
    WHERE w.rug_count >= 5 
      AND t.detected_at > NOW() - INTERVAL '24 hours'
""")
tokens_24h = cur.fetchone()[0]
print(f"\nRugger tokens detected last 24h: {tokens_24h}")
print(f"(Not all would qualify — need wallet with 10+ history + profitable profile)")

conn.close()
