import sys, json, glob, os, subprocess, random
sys.path.insert(0, r"C:/Claude/Projects/srv36-spike-wt/server/tts-sidecar")
import numpy as np
from spikes.srv36.embed import embed_pcm
from spikes.srv36.metrics import cosine, centroid, eer, spread_stats
from spikes.srv36.segments_io import slice_pcm, seg_key
from spikes.srv36.gates import is_gate_flagged

ADIR = r"C:/AudiobookWorkspace/books/Derek Landy/Skulduggery Pleasant/Scepter of the Ancients/audio"
SR=16000; FLOOR=2.0
TARGETS=["narrator","skulduggery-pleasant","stephanie-edgley"]
random.seed(7)

# collect segments per char: (chapterfile, seg, flagged)
bychar={t:{"flag":[],"ok":[]} for t in TARGETS}
for segf in glob.glob(os.path.join(ADIR,"*.segments.json")):
    if ".previous." in segf: continue
    d=json.load(open(segf,encoding="utf-8"))
    for s in d.get("segments",[]):
        ch=s.get("characterId")
        if ch not in TARGETS: continue
        st,en=s.get("startSec"),s.get("endSec")
        if st is None or en is None or (en-st)<FLOOR: continue
        rec=(segf,float(st),float(en))
        (bychar[ch]["flag"] if is_gate_flagged(s) else bychar[ch]["ok"]).append(rec)

_dec={}
def dec(mp3):
    if mp3 not in _dec:
        _dec[mp3]=subprocess.run(["ffmpeg","-v","error","-i",mp3,"-ac","1","-ar",str(SR),"-f","s16le","-"],capture_output=True).stdout
    return _dec[mp3]
def emb(rec):
    segf,st,en=rec; mp3=segf.replace(".segments.json",".mp3")
    if not os.path.exists(mp3): return None
    return embed_pcm(slice_pcm(dec(mp3),SR,st,en),SR)

for ch in TARGETS:
    ok=bychar[ch]["ok"]; flag=bychar[ch]["flag"]
    random.shuffle(ok)
    cen_recs=ok[:40]; held=ok[40:160]
    cen_e=[e for e in (emb(r) for r in cen_recs) if e is not None]
    if len(cen_e)<5: print(f"{ch}: too few clean"); continue
    cen=centroid(cen_e)
    held_s=[cosine(cen,e) for e in (emb(r) for r in held) if e is not None]
    flag_e=[(r,emb(r)) for r in flag]; flag_e=[(r,e) for r,e in flag_e if e is not None]
    flag_s=[cosine(cen,e) for r,e in flag_e]
    print(f"\n=== {ch}: centroid={len(cen_e)} | clean held-out n={len(held_s)} | flagged n={len(flag_s)} ===")
    print(" clean cosine:", {k:round(v,3) for k,v in spread_stats(held_s).items()})
    if flag_s: print(" flagged cosine:", {k:round(v,3) for k,v in spread_stats(flag_s).items()})
    if flag_s and held_s:
        e=eer(genuine=held_s,impostor=flag_s); print(" EER(clean vs flagged):",round(e["eer"],3),"thr",round(e["threshold"],3))
    # F4 candidates: lowest-cosine CLEAN (gate-OK) segments = timbre outliers gates rated OK
    scored=sorted(zip(held_s,held),key=lambda x:x[0])[:6]
    print(" lowest-cosine GATE-OK (acoustic outliers → listen candidates):")
    for c,rec in scored:
        print(f"    cos={c:.3f}  {os.path.basename(rec[0])}  {rec[1]:.1f}-{rec[2]:.1f}s")
print("\nDONE")
