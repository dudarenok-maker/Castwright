import sys, json, glob, os, subprocess, random
sys.path.insert(0, r"C:/Claude/Projects/srv36-spike-wt/server/tts-sidecar")
import numpy as np
from spikes.srv36.embed import embed_pcm
from spikes.srv36.metrics import cosine, centroid
from spikes.srv36.segments_io import slice_pcm
ADIR=r"C:/AudiobookWorkspace/books/Derek Landy/Skulduggery Pleasant/Scepter of the Ancients/audio"
OUT=r"C:/Users/dudar/srv36-listen2"; os.makedirs(OUT,exist_ok=True)
SR=16000; FLOOR=2.0; random.seed(11)
TARGETS={"narrator":"narrator","skulduggery":"skulduggery-pleasant","stephanie":"stephanie-edgley"}
# already-sent (file_stem, start) to exclude
SENT={("11-eight-ghastly",1269.6),("07-four-the-secret-war",709.4),("11-eight-ghastly",318.9),
      ("11-eight-ghastly",1371.4),("16-thirteen-the-red-right-hand",341.9),("19-sixteen-what-s-in-a-name",1.5),
      ("11-eight-ghastly",242.0),("13-ten-the-gal-in-black",671.4)}
recs={t:[] for t in TARGETS}
for segf in glob.glob(os.path.join(ADIR,"*.segments.json")):
    if ".previous." in segf: continue
    stem=os.path.basename(segf).replace(".segments.json","")
    d=json.load(open(segf,encoding="utf-8"))
    for s in d.get("segments",[]):
        ch=s.get("characterId"); v=(s.get("asr") or {}).get("verdict"); st,en=s.get("startSec"),s.get("endSec")
        if v!="ok" or s.get("suspect") or st is None or en is None or en-st<FLOOR: continue
        for short,full in TARGETS.items():
            if ch==full and (stem,round(st,1)) not in SENT: recs[short].append((stem,float(st),float(en)))
_dec={}
def dec(m):
    if m not in _dec: _dec[m]=subprocess.run(["ffmpeg","-v","error","-i",m,"-ac","1","-ar",str(SR),"-f","s16le","-"],capture_output=True).stdout
    return _dec[m]
def emb(stem,st,en):
    mp3=os.path.join(ADIR,stem+".mp3")
    if not os.path.exists(mp3): return None
    return embed_pcm(slice_pcm(dec(mp3),SR,st,en),SR)
manifest=[]
for short,full in TARGETS.items():
    pool=recs[short]; random.shuffle(pool)
    cen_recs=pool[:60]; score_recs=pool[60:360]
    cen=[e for e in (emb(*r) for r in cen_recs) if e is not None]
    cen=centroid(cen)
    scored=[]
    for r in score_recs:
        e=emb(*r)
        if e is not None: scored.append((cosine(cen,e),r))
    scored.sort(key=lambda x:x[0])
    n=len(scored); p05=scored[int(0.05*n)][0]
    print(f"{short}: scored={n} p05={p05:.3f} | cutoff-region picks:")
    for frac in (0.03,0.05,0.07,0.09):
        cosv,r=scored[int(frac*n)]
        side="BELOW-cutoff(flag)" if cosv<p05 else "above-cutoff(pass)"
        nm=f"{short}_cos{cosv:.3f}_pct{int(frac*100)}_{side[:5]}_{r[0][:12]}_{r[1]:.0f}s.mp3"
        manifest.append((short,r[0],r[1],r[2],cosv,frac,side,nm))
        print(f"   cos={cosv:.3f} pct{int(frac*100)} {side}  {r[0]} {r[1]:.0f}s")
# extract
for short,stem,st,en,cosv,frac,side,nm in manifest:
    mp3=os.path.join(ADIR,stem+".mp3")
    subprocess.run(["ffmpeg","-v","error","-y","-ss",str(st),"-to",str(en),"-i",mp3,"-c:a","libmp3lame","-q:a","2",os.path.join(OUT,nm)],check=False)
json.dump([{"char":m[0],"file":m[1],"start":m[2],"cos":m[4],"pct":m[5],"side":m[6],"clip":m[7]} for m in manifest], open(os.path.join(OUT,"manifest.json"),"w"), indent=2)
print("\nEXTRACTED",len(manifest),"clips to",OUT)
