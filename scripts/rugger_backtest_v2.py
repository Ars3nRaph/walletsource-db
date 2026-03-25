#!/usr/bin/env python3
"""
Rugger Backtest v2 — Walk-Forward avec QUALIFICATION du wallet
On ne trade que les wallets qui étaient rentables sur leur training set.
"""
import psycopg2
from collections import defaultdict

conn = psycopg2.connect(host='localhost', dbname='walletsource', user='walletsource', password='walletsource_dev')
cur = conn.cursor()

cur.execute("""
    SELECT t.creator_wallet, t.token_address, t.detected_at,
           t.fdv_at_detection, t.peak_mc, t.time_to_peak_min, t.time_to_rug_min
    FROM token_events t
    JOIN wallet_profiles w ON w.wallet_address = t.creator_wallet
    WHERE w.rug_count >= 5 AND t.peak_mc IS NOT NULL AND t.peak_mc > 0
    ORDER BY t.creator_wallet, t.detected_at
""")

wallets = defaultdict(list)
for row in cur.fetchall():
    wallets[row[0]].append({
        'token': row[1], 'detected_at': row[2],
        'entry_mc': row[3] or 2500, 'peak_mc': row[4],
        'ttp': row[5] or 0, 'ttr': row[6] or 5,
    })

FEES = 0.045
HARD_STOP = -0.35
POS_SIZE = 0.10

def simulate_trades(tokens, target_mc, entry_default=2500):
    """Simulate trades against a target exit MC"""
    pnls = []
    for t in tokens:
        entry = t['entry_mc'] or entry_default
        peak = t['peak_mc']
        if peak >= target_mc:
            pnl = (target_mc - entry) / max(entry, 1) - FEES
            etype = 'TARGET'
        elif peak > entry * 1.05:
            pnl = (peak * 0.6 - entry) / max(entry, 1) - FEES
            etype = 'PARTIAL'
        else:
            pnl = max(HARD_STOP, (peak * 0.5 - entry) / max(entry, 1)) - FEES
            etype = 'LOSS'
        pnls.append((pnl, etype))
    return pnls

# Different MIN_TRAIN sizes to test
for MIN_TRAIN in [10, 15, 20]:
    print(f"\n{'='*80}")
    print(f"TRAIN SIZE = {MIN_TRAIN} tokens")
    print(f"{'='*80}")
    
    for quality_label, quality_filter in [
        ("ALL wallets", lambda cv, train_wr, train_pnl, target: target > 2700),
        ("Target > 3500", lambda cv, train_wr, train_pnl, target: target > 3500),
        ("Train WR > 50%", lambda cv, train_wr, train_pnl, target: target > 2700 and train_wr > 50),
        ("Train WR>50% + Target>3500", lambda cv, train_wr, train_pnl, target: train_wr > 50 and target > 3500),
        ("Train WR>60% + Target>4000", lambda cv, train_wr, train_pnl, target: train_wr > 60 and target > 4000),
        ("CV<0.5 + Target>4000", lambda cv, train_wr, train_pnl, target: cv < 0.5 and target > 4000),
        ("BEST: CV<0.5 + WR>50% + Target>4000", lambda cv, train_wr, train_pnl, target: cv < 0.5 and train_wr > 50 and target > 4000),
    ]:
        all_pnls = []
        n_wallets = 0
        qualified = 0
        
        for wallet_addr, tokens in wallets.items():
            if len(tokens) < MIN_TRAIN + 3:
                continue
            n_wallets += 1
            
            train = tokens[:MIN_TRAIN]
            test = tokens[MIN_TRAIN:]
            
            # Build profile
            train_peaks = sorted([t['peak_mc'] for t in train])
            p25 = train_peaks[int(len(train_peaks)*0.25)]
            avg_p = sum(train_peaks)/len(train_peaks)
            std_p = (sum((p-avg_p)**2 for p in train_peaks)/len(train_peaks))**0.5
            cv = std_p / max(avg_p, 1)
            
            target_mc = p25
            
            # Validate on training set
            train_pnls = simulate_trades(train, target_mc)
            train_wr = sum(1 for p,_ in train_pnls if p > 0) / len(train_pnls) * 100
            train_avg = sum(p for p,_ in train_pnls) / len(train_pnls) * 100
            
            if not quality_filter(cv, train_wr, train_avg, target_mc):
                continue
            qualified += 1
            
            # Test
            test_pnls = simulate_trades(test, target_mc)
            all_pnls.extend([p for p,_ in test_pnls])
        
        if not all_pnls:
            print(f"  {quality_label:45s}  — no qualifying wallets")
            continue
        
        wr = sum(1 for p in all_pnls if p > 0) / len(all_pnls) * 100
        avg = sum(all_pnls) / len(all_pnls) * 100
        wallet = 10.0
        for p in all_pnls:
            wallet *= (1 + p * POS_SIZE)
        
        print(f"  {quality_label:45s}  W={qualified:3d}  N={len(all_pnls):5d}  WR={wr:4.0f}%  avg={avg:+5.1f}%  wallet={wallet:>10.2f}")

# Final: the winning config in detail
print(f"\n{'='*80}")
print("DETAILED RESULTS — BEST CONFIG: CV<0.5, WR>50%, Target>4000, Train=10")
print(f"{'='*80}")

wallet_details = []
for wallet_addr, tokens in wallets.items():
    if len(tokens) < 13:
        continue
    train = tokens[:10]
    test = tokens[10:]
    train_peaks = sorted([t['peak_mc'] for t in train])
    p25 = train_peaks[int(len(train_peaks)*0.25)]
    avg_p = sum(train_peaks)/len(train_peaks)
    std_p = (sum((p-avg_p)**2 for p in train_peaks)/len(train_peaks))**0.5
    cv = std_p / max(avg_p, 1)
    target_mc = p25
    train_pnls = simulate_trades(train, target_mc)
    train_wr = sum(1 for p,_ in train_pnls if p > 0) / len(train_pnls) * 100
    if not (cv < 0.5 and train_wr > 50 and target_mc > 4000):
        continue
    test_pnls = simulate_trades(test, target_mc)
    test_wr = sum(1 for p,_ in test_pnls if p > 0) / len(test_pnls) * 100
    test_avg = sum(p for p,_ in test_pnls) / len(test_pnls) * 100
    w = 10.0
    for p,_ in test_pnls:
        w *= (1 + p * POS_SIZE)
    exits = defaultdict(int)
    for _,e in test_pnls:
        exits[e] += 1
    wallet_details.append({
        'wallet': wallet_addr[:16], 'test': len(test_pnls), 'cv': cv,
        'target': int(target_mc), 'train_wr': train_wr,
        'test_wr': test_wr, 'test_avg': test_avg, 'wallet_sol': w,
        'exits': dict(exits)
    })

wallet_details.sort(key=lambda x: x['wallet_sol'], reverse=True)
print(f"\n{'Wallet':<18s} {'Test':>4s} {'CV':>5s} {'Tgt':>6s} {'TrWR':>5s} {'TeWR':>5s} {'Avg':>6s} {'SOL':>9s} Exits")
print("-" * 95)
for w in wallet_details:
    exits_str = " ".join(f"{k}={v}" for k,v in w['exits'].items())
    print(f"{w['wallet']:<18s} {w['test']:>4d} {w['cv']:>5.2f} {w['target']:>6d} {w['train_wr']:>4.0f}% {w['test_wr']:>4.0f}% {w['test_avg']:>+5.1f}% {w['wallet_sol']:>8.2f}  {exits_str}")

profitable = [w for w in wallet_details if w['wallet_sol'] > 10]
print(f"\nProfitable: {len(profitable)}/{len(wallet_details)} wallets")
print(f"Combined test trades: {sum(w['test'] for w in wallet_details)}")

conn.close()
