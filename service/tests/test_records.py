"""Proposal invariant 9: receipt verification returns exactly one of three outcomes,
and hashing matches core-ts (same known-answer vector as core-ts/test/bundle.test.ts)."""

from hypothesis import given
from hypothesis import strategies as st

from coven_service.common import GENESIS, canonical_json, entry_hash, verify_receipt


def test_known_answer_vector_matches_core_ts():
    e = {"seq": 1, "at": "2026-11-07T12:00:00Z", "type": "vault.created", "data": {"vault": "v1", "name": "Café"}}
    assert canonical_json(e) == '{"at":"2026-11-07T12:00:00Z","data":{"name":"Caf\\u00e9","vault":"v1"},"seq":1,"type":"vault.created"}'
    assert entry_hash(GENESIS, 1, e["at"], e["type"], e["data"]) == "d144a0ccf833f6c0dcd0130b078cbca2fdcad1e21291139d488dd69163fddb50"


def build(types):
    out, h = [], GENESIS
    for i, t in enumerate(types):
        e = {"seq": i + 1, "at": "2026-11-07T00:00:00Z", "type": t, "data": {"i": i}}
        h = entry_hash(h, e["seq"], e["at"], e["type"], e["data"])
        out.append({**e, "hash": h})
    return out


@given(st.lists(st.sampled_from(["a", "b", "c"]), min_size=1, max_size=12), st.data())
def test_three_outcomes(types, data):
    entries = build(types)
    n = data.draw(st.integers(1, len(entries)))
    rec = {"length": n, "head": entries[n - 1]["hash"]}
    assert verify_receipt(entries, rec) == "consistent"
    assert verify_receipt(entries[: n - 1], rec) == "truncated"
    i = data.draw(st.integers(0, n - 1))
    edited = [dict(e) for e in entries]
    edited[i]["data"] = {"i": -1}
    assert verify_receipt(edited, rec) == "altered"
    if n >= 2:
        swapped = list(entries)
        swapped[0], swapped[1] = swapped[1], swapped[0]
        assert verify_receipt(swapped, rec) == "altered"
