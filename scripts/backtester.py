#!/usr/bin/env python3
"""
WalletSource Backtester v1.0 — Replays ALL historical trades with different params.
Usage: python3 scripts/backtester.py [--quick] [--current]
"""
import json, os, sys, re, random
from collections import defaultdict
from dataclasses import dataclass, field
from typing import List, Tuple

def load_all_trades(data_dir="data"):
    files = sorted([f for f in os.listdir(data_dir) if f.startswith("paper-trades.log")])
    all_tokens = {}
    for filename in files:
        by_token = defaultdict(list)
        with open(os.path.join(data_dir, filename)) as f:
            for line in f:
                try: e = json.loads(line); by_token[e['token']].append(e)
                except: pass
        for token, events in by_token.items():
            if token not in all_tokens or len(events) > len(all_tokens[token]):
                all_tokens[token] = events
    return list(all_tokens.values())

@dataclass
class TokenData:
    token: str; observe_mcs: list = field(default_factory=list)
    buyers: int = 0; volume: float = 0; ratio: float = 0; entry_sec: float = 0
    sell_count: int = 0; buy_count: int = 0; dumps: int = 0
    avg_buy_size: float = 0; avg_sell_size: float = 0; top_holder_pct: float = 0
    obs_peak_mc: float = 0; mc_timeline: list = field(default_factory=list)
    baseline_mc: float = 0; entry_mc: float = 0
    actual_pnl: float = 0; actual_exit_type: str = ""

def preprocess(raw_data):
    tokens = []
    for events in raw_data:
        buy = next((e for e in events if e['action'] == 'BUY'), None)
        if not buy: continue
        sell = next((e for e in events if e['action'] == 'SELL'), None)
        td = TokenData(token=events[0]['token']); td.entry_mc = buy['current_mc']
        r = buy.get('reason', '')
        m = re.search(r'(\d+) buyers', r); td.buyers = int(m.group(1)) if m else 0
        m = re.search(r'\$(\d+) vol', r); td.volume = float(m.group(1)) if m else 0
        m = re.search(r'([\d.]+)x base', r); td.ratio = float(m.group(1)) if m else 0
        m = re.search(r'(\d+)s[|\s]', r); td.entry_sec = float(m.group(1)) if m else 0
        m = re.search(r'dumps=(\d+)', r); td.dumps = int(m.group(1)) if m else 0
        m = re.search(r'sells=(\d+)/(\d+)', r)
        if m: td.sell_count = int(m.group(1)); td.buy_count = int(m.group(2))
        m = re.search(r'avgBuy=\$(\d+)', r); td.avg_buy_size = float(m.group(1)) if m else 0
        m = re.search(r'avgSell=\$(\d+)', r); td.avg_sell_size = float(m.group(1)) if m else 0
        m = re.search(r'topHolder=(\d+)%', r); td.top_holder_pct = float(m.group(1)) if m else 0
        obs = sorted([e for e in events if 'OBSERVE' in e.get('reason','')], key=lambda x: float(x['elapsed_min']))
        td.observe_mcs = [o['current_mc'] for o in obs]
        td.baseline_mc = td.observe_mcs[0] if td.observe_mcs else td.entry_mc
        td.obs_peak_mc = max(td.observe_mcs) if td.observe_mcs else td.entry_mc
        for e in sorted(events, key=lambda x: float(x['elapsed_min'])):
            td.mc_timeline.append((float(e['elapsed_min'])*60, e['current_mc']))
        if sell:
            td.actual_pnl = (sell['current_mc'] - td.entry_mc) / td.entry_mc * 100
            for tag, typ in [('TRAIL','TRAIL'),('DROP','TRAIL'),('HARD','HARD_STOP'),('BREAKEVEN','BREAKEVEN'),('NO PUMP','NO_PUMP'),('SWEEP','SWEEP')]:
                if tag in sell['reason']: td.actual_exit_type = typ; break
            else: td.actual_exit_type = 'OTHER'
        tokens.append(td)
    return tokens

@dataclass
class P:
    min_buyers:int=50; max_buyers:int=100; min_ratio:float=2.0; max_ratio:float=2.6
    min_volume:float=1000; max_sell_pressure:float=0.8; entry_window:float=90; observe:float=30
    max_dumps:int=999; max_top_holder:float=100; min_buy_sell_ratio:float=0
    hard_stop:float=-25; max_hold:float=300
    t40:float=0.55; t50:float=0.25; t60:float=0.20; t70:float=0.15
    t80:float=0.10; t90:float=0.05; t100:float=0.05; t100p:float=0.25
    fee:float=4.5

def drop_limit(peak, p):
    if peak>=100: return p.t100p
    if peak>=90: return p.t90
    if peak>=80: return p.t80
    if peak>=70: return p.t70
    if peak>=60: return p.t60
    if peak>=50: return p.t50
    if peak>=40: return p.t40
    return 0

def check_entry(td, p):
    if td.buyers<p.min_buyers or td.buyers>p.max_buyers: return False
    if td.ratio<p.min_ratio or td.ratio>p.max_ratio: return False
    if td.volume<p.min_volume: return False
    if td.entry_sec>p.entry_window or td.entry_sec<p.observe: return False
    if td.buy_count>0 and td.sell_count>td.buy_count*p.max_sell_pressure: return False
    if td.dumps>p.max_dumps: return False
    if td.top_holder_pct>p.max_top_holder: return False
    if td.avg_sell_size>0 and td.avg_buy_size>0 and p.min_buy_sell_ratio>0:
        if td.avg_buy_size/td.avg_sell_size<p.min_buy_sell_ratio: return False
    return True

def sim_exit(td, p):
    entry=td.entry_mc
    if entry<=0: return (0,'ERROR',0)
    buy_idx=None
    for i,(t,mc) in enumerate(td.mc_timeline):
        if abs(mc-entry)/max(entry,1)<0.01: buy_idx=i; break
    if buy_idx is None:
        for i,(t,mc) in enumerate(td.mc_timeline):
            if mc==entry: buy_idx=i; break
    if buy_idx is None: return (td.actual_pnl,td.actual_exit_type,0)
    bt=td.mc_timeline[buy_idx][0]; peak=entry
    for i in range(buy_idx+1,len(td.mc_timeline)):
        t,mc=td.mc_timeline[i]; hs=t-bt
        if hs<=0: continue
        if mc>peak: peak=mc
        pnl=(mc-entry)/entry*100; pp=(peak-entry)/entry*100
        dfp=(peak-mc)/peak if peak>0 else 0
        dl=drop_limit(pp,p)
        if dl>0 and dfp>dl:
            cap=(peak*(1-dl)-entry)/entry*100; return (cap,'TRAIL',hs)
        if pnl<=p.hard_stop: return (p.hard_stop,'HARD_STOP',hs)
        if hs>p.max_hold: return (pnl,'MAX_HOLD',hs)
    if td.mc_timeline:
        lm=td.mc_timeline[-1][1]; return ((lm-entry)/entry*100,'DATA_END',td.mc_timeline[-1][0]-bt)
    return (0,'NO_DATA',0)

def run(tokens, p):
    trades=0; wins=0; tp=0; tn=0; hs=0; tr=0; mh=0; th=0; best=-999; worst=999; w=10.0
    for td in tokens:
        if not check_entry(td,p): continue
        pnl,ext,hold=sim_exit(td,p); net=pnl-p.fee
        trades+=1; tp+=pnl; tn+=net; th+=hold
        if net>0: wins+=1
        if pnl>best: best=pnl
        if pnl<worst: worst=pnl
        if ext=='HARD_STOP': hs+=1
        elif ext=='TRAIL': tr+=1
        elif ext=='MAX_HOLD': mh+=1
        w*=(1+net/100*0.1)
    if trades==0: return None
    return {'t':trades,'w':wins,'wr':wins/trades*100,'ap':tp/trades,'an':tn/trades,
            'hs':hs,'tr':tr,'mh':mh,'best':best,'worst':worst,'wallet':w,
            'hsp':hs/trades*100,'ah':th/trades}

def grid(quick=False):
    c=[("CURRENT",P())]
    for v in [30,40,50,60,70,80]: c.append((f"minB={v}",P(min_buyers=v)))
    for v in [80,100,120,150,999]: c.append((f"maxB={v}",P(max_buyers=v)))
    for lo,hi in [(1.5,2.6),(1.8,2.6),(2.0,3.0),(2.0,2.3),(2.3,3.0),(1.5,3.0),(1.8,3.0)]:
        c.append((f"r={lo}-{hi}",P(min_ratio=lo,max_ratio=hi)))
    for v in [0.4,0.5,0.6,0.7,0.8,0.9,1.0]: c.append((f"sp<{v}",P(max_sell_pressure=v)))
    for v in [60,90,120,180]: c.append((f"ew={v}s",P(entry_window=v)))
    for v in [15,20,30,45,60]: c.append((f"obs={v}s",P(observe=v)))
    for v in [-15,-20,-25,-30,-35,-40,-50]: c.append((f"hs={v}%",P(hard_stop=v)))
    for v in [120,180,300,600,900,1800]: c.append((f"mh={v}s",P(max_hold=v)))
    if not quick:
        for v in [10,20,30,40,50]: c.append((f"dumps<{v}",P(max_dumps=v)))
        for v in [5,8,10,15,20,30]: c.append((f"top<{v}%",P(max_top_holder=v)))
        for v in [0.5,0.7,0.8,1.0,1.2]: c.append((f"bs>{v}",P(min_buy_sell_ratio=v)))
        # Tier variations
        for tp in [0.10,0.15,0.20,0.25,0.30,0.40]:
            c.append((f"flat={int(tp*100)}%",P(t40=tp,t50=tp,t60=tp,t70=tp,t80=tp,t90=tp,t100=tp,t100p=tp)))
        c.append(("TIGHT",P(t40=.30,t50=.15,t60=.10,t70=.08,t80=.05,t90=.03,t100=.03,t100p=.10)))
        c.append(("WIDE",P(t40=.70,t50=.50,t60=.40,t70=.30,t80=.20,t90=.15,t100=.10,t100p=.30)))
        c.append(("NO_TIERS",P(t40=0,t50=0,t60=0,t70=0,t80=0,t90=0,t100=0,t100p=0)))
    # Combined
    c.append(("QUALITY",P(min_buyers=60,max_buyers=90,min_ratio=2.0,max_ratio=2.5,max_sell_pressure=0.6,hard_stop=-30,max_hold=600)))
    c.append(("WIDE_NET",P(min_buyers=30,max_buyers=150,min_ratio=1.5,max_ratio=3.0,max_sell_pressure=1.0)))
    c.append(("DIAMOND",P(hard_stop=-40,max_hold=900,t40=.80,t50=.60,t60=.50,t70=.40,t80=.30,t90=.20,t100=.15,t100p=.30)))
    c.append(("SNIPER",P(min_buyers=60,max_buyers=80,min_ratio=2.0,max_ratio=2.4,max_sell_pressure=0.5,entry_window=60,hard_stop=-20,t40=.15,t50=.10,t60=.08,t70=.05,t80=.05,t90=.03,t100=.03,t100p=.10)))
    return c

def genetic(top,n=100):
    c=[]
    params=[p for _,_,p in top[:10]]
    if len(params)<3: return c
    for i in range(n):
        p1,p2=random.choice(params),random.choice(params)
        child=P(
            min_buyers=random.choice([p1.min_buyers,p2.min_buyers])+random.choice([-5,0,0,5]),
            max_buyers=random.choice([p1.max_buyers,p2.max_buyers]),
            min_ratio=round(random.choice([p1.min_ratio,p2.min_ratio])+random.choice([-0.1,0,0,0.1]),1),
            max_ratio=round(random.choice([p1.max_ratio,p2.max_ratio])+random.choice([-0.1,0,0,0.1]),1),
            max_sell_pressure=random.choice([p1.max_sell_pressure,p2.max_sell_pressure]),
            entry_window=random.choice([p1.entry_window,p2.entry_window]),
            observe=random.choice([p1.observe,p2.observe]),
            hard_stop=random.choice([p1.hard_stop,p2.hard_stop])+random.choice([-3,0,0,3]),
            max_hold=random.choice([p1.max_hold,p2.max_hold]),
            max_dumps=random.choice([p1.max_dumps,p2.max_dumps]),
            max_top_holder=random.choice([p1.max_top_holder,p2.max_top_holder]),
            t40=random.choice([p1.t40,p2.t40]),t50=random.choice([p1.t50,p2.t50]),
            t60=random.choice([p1.t60,p2.t60]),t70=random.choice([p1.t70,p2.t70]),
            t80=random.choice([p1.t80,p2.t80]),t90=random.choice([p1.t90,p2.t90]),
            t100=random.choice([p1.t100,p2.t100]),t100p=random.choice([p1.t100p,p2.t100p]),
        )
        c.append((f"G{i}",child))
    return c

def main():
    quick='--quick' in sys.argv; cur='--current' in sys.argv
    print("="*80); print("  WalletSource Backtester v1.0"); print("="*80)
    print("\n📂 Loading data...")
    raw=load_all_trades(); tokens=preprocess(raw)
    wn=sum(1 for t in tokens if t.dumps>0 or t.top_holder_pct>0)
    ticks=sum(len(t.mc_timeline) for t in tokens)
    print(f"   {len(tokens)} tokens | {wn} with on-chain metrics | {ticks:,} data points")
    
    combos=([("CURRENT",P())] if cur else grid(quick))
    print(f"\n🧪 Testing {len(combos)} strategies...")
    
    results=[]
    for i,(name,p) in enumerate(combos):
        r=run(tokens,p)
        if r and r['t']>=10: results.append((name,r,p))
        if (i+1)%25==0: print(f"   {i+1}/{len(combos)}...")
    
    if not cur and not quick:
        results.sort(key=lambda x: x[1]['an'],reverse=True)
        gc=genetic(results,200)
        print(f"\n🧬 Genetic round: {len(gc)} evolved strategies...")
        for name,p in gc:
            r=run(tokens,p)
            if r and r['t']>=10: results.append((name,r,p))
    
    results.sort(key=lambda x: (x[1]['an']>0, x[1]['wallet']),reverse=True)
    
    print("\n"+"="*80); print("  TOP 25 STRATEGIES"); print("="*80)
    print(f"{'#':<3} {'Name':<24} {'Trades':>6} {'WR':>5} {'Brut':>7} {'Net':>7} {'Wallet':>7} {'HS%':>5} {'Best':>6}")
    print("-"*78)
    for i,(n,r,p) in enumerate(results[:25]):
        m="✅" if r['an']>0 else "❌"
        print(f"{i+1:<3} {n:<24} {r['t']:>6} {r['wr']:>4.0f}% {r['ap']:>+6.1f}% {r['an']:>+6.1f}% {r['wallet']:>6.2f} {r['hsp']:>4.0f}% {r['best']:>+5.0f}% {m}")
    
    cur_r=next(((n,r,p) for n,r,p in results if n=="CURRENT"),None)
    if cur_r:
        n,r,p=cur_r
        rank=next(i+1 for i,(nn,_,_) in enumerate(results) if nn=="CURRENT")
        print(f"\n📌 CURRENT (#{rank}): {r['t']}t WR {r['wr']:.0f}% net {r['an']:+.1f}% wallet {r['wallet']:.2f}")
    
    if results:
        n,r,p=results[0]
        print(f"\n{'='*80}\n  🏆 BEST: {n}\n{'='*80}")
        print(f"  {r['t']}t | WR {r['wr']:.1f}% | Brut {r['ap']:+.1f}% | Net {r['an']:+.1f}% | Wallet {r['wallet']:.2f} ({(r['wallet']/10-1)*100:+.1f}%)")
        print(f"  HS: {r['hs']} ({r['hsp']:.0f}%) | Trail: {r['tr']} | MaxHold: {r['mh']} | Best: {r['best']:+.1f}% | Worst: {r['worst']:+.1f}%")
        print(f"  Params:")
        d=p.__dict__; df=P().__dict__
        diffs={k:v for k,v in d.items() if v!=df[k] and k!='fee'}
        if diffs: 
            for k,v in diffs.items(): print(f"    {k}: {df[k]} → {v}")
        else: print("    (same as current)")
        
        # Save
        out={'tokens':len(tokens),'tested':len(combos),'top25':[]}
        for n,r,p in results[:25]:
            diffs={k:v for k,v in p.__dict__.items() if v!=P().__dict__[k] and k!='fee'}
            out['top25'].append({'name':n,'trades':r['t'],'wr':round(r['wr'],1),
                'brut':round(r['ap'],1),'net':round(r['an'],1),'wallet':round(r['wallet'],2),
                'hs_pct':round(r['hsp'],0),'params':diffs})
        with open('data/backtest_results.json','w') as f: json.dump(out,f,indent=2)
        print(f"\n💾 Results → data/backtest_results.json")
    print("="*80)

if __name__=='__main__': main()
