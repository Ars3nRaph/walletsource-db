#!/usr/bin/env python3
"""
Paper Trade Report — WalletSourceDB
Match BUY → SELL par token, calcule P&L, affiche un rapport complet.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime

LOG_FILE = '/root/walletsource-db/data/paper-trades.log'

def load_trades():
    trades = []
    with open(LOG_FILE) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    trades.append(json.loads(line))
                except:
                    pass
    return trades

def analyze():
    trades = load_trades()

    # Grouper par token
    by_token = defaultdict(list)
    for t in trades:
        by_token[t['token']].append(t)

    # Stats globales
    total     = len(trades)
    by_action = defaultdict(int)
    by_reason = defaultdict(int)
    for t in trades:
        by_action[t['action']] += 1
        by_reason[t.get('reason','?')] += 1

    # Matcher BUY → SELL pour P&L
    matched_trades = []
    open_positions = {}  # token → BUY entry

    for token, events in by_token.items():
        events_sorted = sorted(events, key=lambda x: x['timestamp'])
        for ev in events_sorted:
            action = ev['action']
            if action == 'BUY':
                open_positions[token] = ev
            elif action == 'SELL' and token in open_positions:
                buy  = open_positions.pop(token)
                sell = ev
                entry_mc = float(buy['current_mc'])
                exit_mc  = float(sell['current_mc'])
                pct_change = ((exit_mc - entry_mc) / entry_mc) * 100 if entry_mc > 0 else 0
                matched_trades.append({
                    'token':      token,
                    'buy_time':   buy['timestamp'],
                    'sell_time':  sell['timestamp'],
                    'entry_mc':   entry_mc,
                    'exit_mc':    exit_mc,
                    'pct_change': pct_change,
                    'buy_reason': buy.get('reason','?'),
                    'sell_reason':sell.get('reason','?'),
                    'strategy':   buy.get('strategy','?'),
                    'confidence': buy.get('confidence','?'),
                    'hold_min':   (datetime.fromisoformat(sell['timestamp'].replace('Z','+00:00')) -
                                   datetime.fromisoformat(buy['timestamp'].replace('Z','+00:00'))).total_seconds() / 60
                })

    # Positions ouvertes sans SELL
    open_count = len(open_positions)

    # ── Affichage ──────────────────────────────────────────────────────────────
    W = 70
    print()
    print("╔" + "═"*W + "╗")
    print("║" + "  📊 WalletSourceDB — Paper Trade Report".center(W) + "║")
    print("╚" + "═"*W + "╝")
    print()

    print(f"  Total signaux loggés : {total:>6}")
    for action, count in sorted(by_action.items()):
        bar = '█' * min(40, count // 10)
        print(f"    {action:<6} : {count:>5}  {bar}")
    print()

    print("  Top raisons (NONE filtrés) :")
    sorted_reasons = sorted([(v,k) for k,v in by_reason.items() if k != 'No playbook - not a predictable rugger'], reverse=True)
    for count, reason in sorted_reasons[:10]:
        print(f"    {count:>5}x  {reason}")
    print()

    # P&L
    print("─"*(W+2))
    print(f"  Trades complétés (BUY→SELL matchés) : {len(matched_trades)}")
    print(f"  Positions ouvertes (BUY sans SELL)  : {open_count}")
    print()

    if matched_trades:
        winners = [t for t in matched_trades if t['pct_change'] > 0]
        losers  = [t for t in matched_trades if t['pct_change'] <= 0]
        avg_pnl = sum(t['pct_change'] for t in matched_trades) / len(matched_trades)
        best    = max(matched_trades, key=lambda x: x['pct_change'])
        worst   = min(matched_trades, key=lambda x: x['pct_change'])

        print(f"  Win rate   : {len(winners)}/{len(matched_trades)} ({100*len(winners)/len(matched_trades):.1f}%)")
        print(f"  Avg P&L    : {avg_pnl:+.2f}%")
        print(f"  Best trade : {best['pct_change']:+.2f}%  @ {best['token'][:20]}...")
        print(f"  Worst trade: {worst['pct_change']:+.2f}%  @ {worst['token'][:20]}...")
        print()
        print("  Détail des trades :")
        print(f"  {'Token':<22} {'Entry MC':>9} {'Exit MC':>9} {'P&L':>7} {'Hold':>6} {'Sell reason'}")
        print("  " + "─"*68)
        for t in sorted(matched_trades, key=lambda x: x['pct_change'], reverse=True):
            emoji = '🟢' if t['pct_change'] > 0 else '🔴'
            print(f"  {emoji} {t['token'][:20]:<20} "
                  f"${t['entry_mc']:>8,.0f} "
                  f"${t['exit_mc']:>8,.0f} "
                  f"{t['pct_change']:>+6.1f}% "
                  f"{t['hold_min']:>5.1f}m "
                  f"  {t['sell_reason'][:30]}")
    else:
        print("  ⚠️  Aucun trade BUY→SELL complété pour l'instant.")
        print("  Les BUY apparaîtront dès qu'un rugger RIDE avec avg_peak_mc ≥ $3500")
        print("  lance un token pendant sa fenêtre d'entrée.")

    # Positions ouvertes
    if open_positions:
        print()
        print("  Positions actuellement ouvertes :")
        for token, buy in open_positions.items():
            print(f"    {token[:30]}  entry MC: ${float(buy['current_mc']):,.0f}  @ {buy['elapsed_min']}min")

    print()
    print("═"*(W+2))

if __name__ == '__main__':
    analyze()
