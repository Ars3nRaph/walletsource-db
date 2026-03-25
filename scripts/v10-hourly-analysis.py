#!/usr/bin/env python3
"""v10 Hourly Analysis — called by OpenClaw cron"""
import json, re, os
from collections import defaultdict
from datetime import datetime, timezone

LOG = "/root/walletsource-db/data/paper-trades.log"
HISTORY = "/root/walletsource-db/data/v10-analysis-history.jsonl"

def analyze():
    by_token = defaultdict(list)
    with open(LOG) as f:
        for line in f:
            try: by_token[json.loads(line)["token"]].append(json.loads(line))
            except: pass

    pairs = []
    for token, evals in by_token.items():
        buy = next((e for e in evals if e["action"] == "BUY"), None)
        sell = next((e for e in evals if e["action"] == "SELL"), None)
        holds = [e for e in evals if e["action"] == "HOLD"]
        if not buy: continue
        entry = buy["current_mc"]
        exit_mc = sell["current_mc"] if sell else None
        peak = max([h["current_mc"] for h in holds] + [entry])
        pnl = ((exit_mc - entry)/entry*100) if exit_mc else None
        peak_pnl = (peak - entry)/entry*100
        m = re.search(r'(\d+) buyers', buy["reason"])
        buyers = int(m.group(1)) if m else 0
        m2 = re.search(r'\$(\d+) vol', buy["reason"])
        vol = int(m2.group(1)) if m2 else 0
        m3 = re.search(r'([\d.]+)x base', buy["reason"])
        ratio = float(m3.group(1)) if m3 else 0
        tier = "HIGH" if "[HIGH]" in buy["reason"] else "MID" if "[MID]" in buy["reason"] else "BASE"
        exit_type = "OPEN"
        if sell:
            r = sell["reason"]
            for k in ["HARD STOP","TRAIL","BREAKEVEN","CASCADE","NO PUMP","MAX HOLD","SWEEP"]:
                if k in r: exit_type = k.replace(" ","_"); break
        pairs.append(dict(token=token[:12],entry=entry,exit=exit_mc,peak=peak,pnl=pnl,
            peak_pnl=peak_pnl,buyers=buyers,vol=vol,ratio=ratio,tier=tier,exit_type=exit_type))
    return pairs

def report(pairs):
    closed = [p for p in pairs if p["pnl"] is not None and p["exit_type"] not in ("SWEEP","OPEN")]
    if len(closed) < 3: return f"Only {len(closed)} closed trades — need more data.", {}
    wins = [p for p in closed if p["pnl"]>0]
    wr = len(wins)/len(closed)*100
    avg_pnl = sum(p["pnl"] for p in closed)/len(closed)
    total = sum(p["pnl"] for p in closed)
    avg_win = sum(p["pnl"] for p in wins)/len(wins) if wins else 0
    avg_loss = sum(p["pnl"] for p in [p for p in closed if p["pnl"]<=0])/len([p for p in closed if p["pnl"]<=0]) if any(p["pnl"]<=0 for p in closed) else 0
    
    out = [f"📊 v10 — {len(closed)} trades | WR {wr:.0f}% | Avg {avg_pnl:+.1f}% | Total {total:+.0f}%"]
    out.append(f"   Avg win {avg_win:+.1f}% | Avg loss {avg_loss:+.1f}%")
    
    for tier in ["HIGH","MID","BASE"]:
        tp=[p for p in closed if p["tier"]==tier]
        if tp:
            w=sum(1 for p in tp if p["pnl"]>0)
            out.append(f"   {tier}: {len(tp)}t, WR={100*w/len(tp):.0f}%, avg {sum(p['pnl'] for p in tp)/len(tp):+.1f}%")
    
    out.append("")
    for et in ["TRAIL","CASCADE","BREAKEVEN","HARD_STOP","NO_PUMP"]:
        ep=[p for p in closed if p["exit_type"]==et]
        if ep:
            w=sum(1 for p in ep if p["pnl"]>0)
            out.append(f"   {et}: {len(ep)}t, {w}W, avg {sum(p['pnl'] for p in ep)/len(ep):+.1f}%")
    
    out.append("")
    for lo,hi,label in [(0,1.3,"<1.3x"),(1.3,2,"1.3-2x"),(2,3,"2-3x"),(3,99,"3x+")]:
        rp=[p for p in closed if lo<=p["ratio"]<hi]
        if rp:
            w=sum(1 for p in rp if p["pnl"]>0)
            out.append(f"   Ratio {label}: {len(rp)}t, WR={100*w/len(rp):.0f}%, avg {sum(p['pnl'] for p in rp)/len(rp):+.1f}%")
    
    # Problems
    issues = []
    hs=[p for p in closed if p["exit_type"]=="HARD_STOP"]
    if hs and len(hs)>len(closed)*0.25:
        np=sum(1 for p in hs if p["peak_pnl"]<3)
        issues.append(f"🔴 {len(hs)} hard stops ({100*len(hs)/len(closed):.0f}%), {np} never pumped")
    if wr<50: issues.append(f"🔴 WR {wr:.0f}% < 50%")
    missed=[p for p in closed if p["peak_pnl"]>25 and (p["pnl"] or 0)<=0]
    if missed: issues.append(f"🟡 {len(missed)} trades peaked >25% but lost")
    
    best=sorted(closed,key=lambda p:p["pnl"],reverse=True)[:3]
    out.append("\n🏆 Top: " + " | ".join(f"{p['token']} {p['pnl']:+.0f}%" for p in best))
    
    if issues:
        out.append("\n⚠️ Issues:")
        out.extend(f"  {i}" for i in issues)
    
    stats = dict(ts=datetime.now(timezone.utc).isoformat(),n=len(closed),wr=round(wr,1),
        avg=round(avg_pnl,2),total=round(total,1),hard_stop_pct=round(100*len(hs)/max(len(closed),1),1))
    with open(HISTORY,"a") as f: f.write(json.dumps(stats)+"\n")
    
    return "\n".join(out), stats

if __name__=="__main__":
    pairs = analyze()
    txt, stats = report(pairs)
    print(txt)
