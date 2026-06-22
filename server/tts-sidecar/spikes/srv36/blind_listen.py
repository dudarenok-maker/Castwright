"""Blinded G5 operator-listen set builder + scorer (C5). Deterministic, label-free."""
from __future__ import annotations
import random


_AUDIO_FIELDS = ("id", "audio", "start", "end")  # carried; everything else (labels) dropped


def build_blind_set(flagged, matched, seed: int):
    answer_key, pool = {}, []
    for truth, clips in (("flagged", flagged), ("matched", matched)):
        for c in clips:
            answer_key[c["id"]] = truth
            pool.append({k: c[k] for k in _AUDIO_FIELDS if k in c})  # strip labels, keep audio
    random.Random(seed).shuffle(pool)   # deterministic interleave
    return pool, answer_key


def score_blind(answer_key: dict, operator_labels: dict) -> dict:
    fp = fn = n_flagged = n_matched = 0
    for cid, truth in answer_key.items():
        op = operator_labels.get(cid)
        if truth == "flagged":
            n_flagged += 1
            if op == "clean":
                fn += 1            # real drift the operator heard as clean
        else:
            n_matched += 1
            if op == "drift":
                fp += 1            # clean clip the operator heard as drift
    return {"fp": fp, "fn": fn,
            "fp_rate": fp / n_matched if n_matched else 0.0,
            "fn_rate": fn / n_flagged if n_flagged else 0.0}
