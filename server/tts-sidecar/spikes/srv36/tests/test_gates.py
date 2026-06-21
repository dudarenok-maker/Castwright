from spikes.srv36.gates import is_gate_flagged


def test_flagged_on_asr_drift():
    assert is_gate_flagged({"asr": {"verdict": "drift"}, "qa": {}, "suspect": False}) is True


def test_flagged_on_suspect_or_qa_suspect():
    assert is_gate_flagged({"asr": {}, "qa": {}, "suspect": True}) is True
    assert is_gate_flagged({"asr": {}, "qa": {"status": "suspect"}, "suspect": False}) is True


def test_not_flagged_on_ok_or_inconclusive():
    assert is_gate_flagged({"asr": {"verdict": "ok"}, "qa": {"status": "ok"}, "suspect": False}) is False
    assert is_gate_flagged({"asr": {"verdict": "inconclusive"}, "qa": {}, "suspect": False}) is False
