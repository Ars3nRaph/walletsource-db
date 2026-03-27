#!/usr/bin/env python3
"""
Helius Wallet Backfill — Analyze top wallets' pump.fun trading history
Uses Enhanced Transactions API to get full trade history
"""
import requests, json, time, sys, os
import psycopg2
from datetime import datetime, timezone

API_KEY = "981f9d6d-2dbb-4171-8424-f12b610e290d"
BASE_URL = f"https://api.helius.xyz/v0"
DB_PARAMS = dict(host="localhost", database="walletsource", user="walletsource", password="walletsource_dev")

def get_transactions(wallet, before=None, limit=100):
    """Fetch parsed transactions for a wallet"""
    url = f"{BASE_URL}/addresses/{wallet}/transactions?api-key={API_KEY}&limit={limit}"
    if before:
        url += f"&before={before}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()

def extract_pump_trades(wallet, txs):
    """Extract pump.fun BUY/SELL from parsed transactions"""
    trades = []
    for tx in txs:
        if tx.get('source') != 'PUMP_FUN' or tx.get('type') != 'SWAP':
            continue
        
        # Determine buy or sell by checking native transfers
        sol_spent = 0
        sol_received = 0
        token_mint = None
        token_amount = 0
        
        for nt in tx.get('nativeTransfers', []):
            if nt['fromUserAccount'] == wallet:
                sol_spent += nt['amount']
            elif nt['toUserAccount'] == wallet:
                sol_received += nt['amount']
        
        for tt in tx.get('tokenTransfers', []):
            token_mint = tt.get('mint')
            token_amount = tt.get('tokenAmount', 0)
            if tt.get('toUserAccount') == wallet:
                action = 'BUY'
            elif tt.get('fromUserAccount') == wallet:
                action = 'SELL'
            else:
                continue
        
        if not token_mint:
            continue
        
        # Convert lamports to SOL
        net_sol = (sol_received - sol_spent) / 1e9
        
        trades.append({
            'wallet': wallet,
            'signature': tx.get('signature'),
            'timestamp': datetime.fromtimestamp(tx['timestamp'], tz=timezone.utc),
            'action': action,
            'token_mint': token_mint,
            'token_amount': token_amount,
            'sol_amount': abs(net_sol),
            'net_sol': net_sol,  # negative = bought, positive = sold
            'fee_lamports': tx.get('fee', 0)
        })
    
    return trades

def backfill_wallet(wallet, max_pages=20):
    """Get all pump.fun trades for a wallet"""
    all_trades = []
    before = None
    
    for page in range(max_pages):
        txs = get_transactions(wallet, before=before)
        if not txs:
            break
        
        trades = extract_pump_trades(wallet, txs)
        all_trades.extend(trades)
        
        # Pagination: use last signature
        before = txs[-1].get('signature')
        
        if len(txs) < 100:
            break
        
        time.sleep(0.1)  # Rate limit courtesy
    
    return all_trades

def compute_pnl(trades):
    """Pair BUY/SELL by token to compute P&L"""
    from collections import defaultdict
    by_token = defaultdict(list)
    for t in trades:
        by_token[t['token_mint']].append(t)
    
    results = []
    for token, token_trades in by_token.items():
        buys = sorted([t for t in token_trades if t['action'] == 'BUY'], key=lambda x: x['timestamp'])
        sells = sorted([t for t in token_trades if t['action'] == 'SELL'], key=lambda x: x['timestamp'])
        
        total_bought_sol = sum(t['sol_amount'] for t in buys)
        total_sold_sol = sum(t['sol_amount'] for t in sells)
        
        if buys and total_bought_sol > 0:
            pnl_sol = total_sold_sol - total_bought_sol
            pnl_pct = (pnl_sol / total_bought_sol) * 100 if total_bought_sol > 0 else 0
            hold_sec = (sells[-1]['timestamp'] - buys[0]['timestamp']).total_seconds() if sells else None
            
            results.append({
                'wallet': buys[0]['wallet'],
                'token': token,
                'buy_sol': total_bought_sol,
                'sell_sol': total_sold_sol,
                'pnl_sol': pnl_sol,
                'pnl_pct': pnl_pct,
                'n_buys': len(buys),
                'n_sells': len(sells),
                'first_buy': buys[0]['timestamp'],
                'last_sell': sells[-1]['timestamp'] if sells else None,
                'hold_sec': hold_sec,
                'is_open': len(sells) == 0
            })
    
    return results

def main():
    conn = psycopg2.connect(**DB_PARAMS)
    cur = conn.cursor()
    
    # Create backfill table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS wallet_backfill (
            id SERIAL PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            token_mint TEXT NOT NULL,
            buy_sol REAL,
            sell_sol REAL,
            pnl_sol REAL,
            pnl_pct REAL,
            n_buys INT,
            n_sells INT,
            first_buy TIMESTAMPTZ,
            last_sell TIMESTAMPTZ,
            hold_sec REAL,
            is_open BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, token_mint)
        );
        CREATE INDEX IF NOT EXISTS idx_wb_wallet ON wallet_backfill(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_wb_pnl ON wallet_backfill(pnl_pct DESC);
    """)
    conn.commit()
    
    # Get target wallets: ELITE + top GOOD
    cur.execute("""
        SELECT wallet_address, category, tokens_total, ROUND(win_rate::numeric*100,1) as wr
        FROM wallet_stats 
        WHERE (category = 'ELITE' OR (category = 'GOOD' AND win_rate >= 0.65))
          AND tokens_total >= 10
        ORDER BY win_rate DESC, tokens_total DESC
        LIMIT 100
    """)
    wallets = cur.fetchall()
    
    print(f"🎯 Backfilling {len(wallets)} wallets...")
    
    total_trades = 0
    total_calls = 0
    
    for i, (addr, cat, n_trades, wr) in enumerate(wallets):
        # Skip already backfilled
        cur.execute("SELECT count(*) FROM wallet_backfill WHERE wallet_address = %s", (addr,))
        existing = cur.fetchone()[0]
        if existing > 0:
            print(f"  [{i+1}/{len(wallets)}] {addr[:8]}... already has {existing} tokens, skip")
            continue
        
        print(f"  [{i+1}/{len(wallets)}] {addr[:8]}... ({cat} | {n_trades}t | WR {wr}%)", end=" ", flush=True)
        
        try:
            # Fetch all pump.fun trades
            trades = backfill_wallet(addr, max_pages=20)
            total_calls += (len(trades) // 100) + 1
            
            if not trades:
                print("→ 0 pump trades")
                continue
            
            # Compute P&L per token
            results = compute_pnl(trades)
            
            # Insert into DB
            for r in results:
                cur.execute("""
                    INSERT INTO wallet_backfill 
                        (wallet_address, token_mint, buy_sol, sell_sol, pnl_sol, pnl_pct, 
                         n_buys, n_sells, first_buy, last_sell, hold_sec, is_open)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (wallet_address, token_mint) DO UPDATE SET
                        buy_sol = EXCLUDED.buy_sol, sell_sol = EXCLUDED.sell_sol,
                        pnl_sol = EXCLUDED.pnl_sol, pnl_pct = EXCLUDED.pnl_pct,
                        n_buys = EXCLUDED.n_buys, n_sells = EXCLUDED.n_sells,
                        last_sell = EXCLUDED.last_sell, hold_sec = EXCLUDED.hold_sec,
                        is_open = EXCLUDED.is_open
                """, (r['wallet'], r['token'], r['buy_sol'], r['sell_sol'], r['pnl_sol'], r['pnl_pct'],
                      r['n_buys'], r['n_sells'], r['first_buy'], r['last_sell'], r['hold_sec'], r['is_open']))
            
            conn.commit()
            total_trades += len(results)
            
            closed = [r for r in results if not r['is_open']]
            wins = [r for r in closed if r['pnl_sol'] > 0]
            wr_actual = len(wins)/len(closed)*100 if closed else 0
            avg_pnl = sum(r['pnl_pct'] for r in closed)/len(closed) if closed else 0
            
            print(f"→ {len(results)} tokens ({len(closed)} closed, WR {wr_actual:.0f}%, avg {avg_pnl:+.1f}%)")
            
        except Exception as e:
            print(f"→ ERROR: {e}")
            conn.rollback()
            continue
        
        time.sleep(0.2)  # Rate limit
    
    # Summary analysis
    print(f"\n{'='*60}")
    print(f"📊 Backfill complete: {total_trades} token trades from {len(wallets)} wallets")
    print(f"   API calls: ~{total_calls}")
    
    cur.execute("""
        SELECT 
            count(*) as total_tokens,
            count(*) FILTER (WHERE NOT is_open) as closed,
            count(*) FILTER (WHERE pnl_sol > 0 AND NOT is_open) as wins,
            ROUND(AVG(pnl_pct) FILTER (WHERE NOT is_open)::numeric, 1) as avg_pnl,
            ROUND(SUM(pnl_sol) FILTER (WHERE NOT is_open)::numeric, 2) as total_pnl_sol,
            ROUND(AVG(hold_sec) FILTER (WHERE NOT is_open AND hold_sec IS NOT NULL)::numeric, 0) as avg_hold_sec
        FROM wallet_backfill
    """)
    row = cur.fetchone()
    print(f"\n🔍 Aggregate stats:")
    print(f"   Tokens: {row[0]} ({row[1]} closed, {row[0]-row[1]} open)")
    if row[1] > 0:
        print(f"   WR: {row[2]}/{row[1]} = {row[2]/row[1]*100:.1f}%")
        print(f"   Avg P&L: {row[3]}%")
        print(f"   Total P&L: {row[4]} SOL")
        print(f"   Avg hold: {row[5]}s")
    
    # Top patterns
    cur.execute("""
        SELECT wallet_address, 
               count(*) as tokens,
               count(*) FILTER (WHERE pnl_sol > 0 AND NOT is_open) as wins,
               count(*) FILTER (WHERE NOT is_open) as closed,
               ROUND(AVG(pnl_pct) FILTER (WHERE NOT is_open)::numeric, 1) as avg_pnl,
               ROUND(AVG(buy_sol)::numeric, 3) as avg_pos,
               ROUND(AVG(hold_sec) FILTER (WHERE NOT is_open AND hold_sec IS NOT NULL)::numeric, 0) as avg_hold
        FROM wallet_backfill
        GROUP BY wallet_address
        HAVING count(*) FILTER (WHERE NOT is_open) >= 5
        ORDER BY AVG(pnl_pct) FILTER (WHERE NOT is_open) DESC
        LIMIT 15
    """)
    print(f"\n🏆 Top wallets by avg P&L (on-chain verified):")
    print(f"   {'Wallet':<12} {'Tokens':>6} {'WR':>6} {'Avg P&L':>9} {'Avg Pos':>8} {'Hold':>6}")
    for row in cur.fetchall():
        wr = f"{row[2]}/{row[3]}" if row[3] > 0 else "—"
        wr_pct = f"{row[2]/row[3]*100:.0f}%" if row[3] > 0 else "—"
        print(f"   {row[0][:12]} {row[1]:>6} {wr_pct:>6} {row[4]:>+8.1f}% {row[5]:>7.3f} {row[6] or 0:>5.0f}s")
    
    conn.close()
    print("\n✅ Done!")

if __name__ == "__main__":
    main()
