import pytest
from spikes.srv36.aggregates import f1_floor, f3_separability, residual_value, f5_length_coverage


def test_f1_floor_tight_vs_wide():
    assert f1_floor([0.95, 0.96, 0.94, 0.95])["floor_ok"] is True
    assert f1_floor([0.95, 0.40, 0.80, 0.55])["floor_ok"] is False  # wide → swamps drift


def test_f3_separability():
    assert f3_separability([0.95, 0.96], [0.50, 0.55])["separable"] is True
    assert f3_separability([0.80, 0.82], [0.79, 0.81])["separable"] is False


def test_residual_value_is_acoustic_minus_gates():
    out = residual_value(
        acoustic_flagged_keys={"a", "b", "c"},
        gate_flagged_keys={"b"},          # gates only caught b
        confirmed_real=1,                  # human confirmed 1 of {a,c} is real drift
    )
    assert out["missed_by_gates"] == {"a", "c"}
    assert out["residual_fraction"] == pytest.approx(1 / 3)
    assert out["confirmed_real"] == 1


def test_f5_floor_and_coverage():
    out = f5_length_coverage(
        {0.5: [0.6, 0.9], 2.0: [0.97, 0.98], 5.0: [1.0, 1.0]}, [0.5, 3.0], 2.0)
    assert out["min_scorable_sec"] == 2.0
    assert out["coverage"] == 0.5


from spikes.srv36.synthesize import decide


def test_decide_go_requires_all_four():
    go = decide({"floor_ok": True}, {"separable": True},
                {"residual_fraction": 0.3, "confirmed_real": 4}, {"coverage": 0.7})
    assert go["recommendation"] == "go"


def test_decide_nogo_when_no_residual_value():
    nogo = decide({"floor_ok": True}, {"separable": True},
                  {"residual_fraction": 0.0, "confirmed_real": 0}, {"coverage": 0.9})
    assert nogo["recommendation"] == "no-go"
    assert any("residual" in r.lower() or "redundant" in r.lower() for r in nogo["reasons"])


def test_decide_nogo_when_floor_wide():
    out = decide({"floor_ok": False}, {"separable": True},
                 {"residual_fraction": 0.5, "confirmed_real": 5}, {"coverage": 0.9})
    assert out["recommendation"] == "no-go"


def test_decide_is_exactly_go_or_nogo():
    out = decide({"floor_ok": True}, {"separable": False},
                 {"residual_fraction": 0.2, "confirmed_real": 2}, {"coverage": 0.2})
    assert out["recommendation"] in ("go", "no-go")
