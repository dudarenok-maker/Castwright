from spikes.srv36.synth_client import build_request


def test_build_request_shape():
    result = build_request("hi", "qwen-abc")
    assert result == {"text": "hi", "engine": "qwen", "voice": "qwen-abc"}
