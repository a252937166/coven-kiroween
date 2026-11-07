"""Spec 05 task 7.2: Hypothesis RuleBasedStateMachine over the petition domain.

Invariants checked after every step:
- no release material below quorum or from a terminal state (T-01, T-04);
- a terminal state never changes (T-04);
- the approval count equals the distinct eligible approvers (T-11, BG-01.4);
- petitions of a superseded version are Invalidated (T-09);
- release only to the bound requester (T-05).
"""

from __future__ import annotations

import os
import tempfile
import uuid

from hypothesis import HealthCheck, settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule

from conftest import fake_envelope, fake_sym, raw_public_key
from coven_service import db, petitions
from coven_service.common import Rejected

APPROVERS = ["user:sage", "user:rowan", "user:ash"]
OTHERS = ["user:robin", "user:kit"]
TERMINAL = {"Expired", "Denied", "Invalidated"}


class PetitionMachine(RuleBasedStateMachine):
    def __init__(self):
        super().__init__()
        self.dir = tempfile.mkdtemp()
        path = os.path.join(self.dir, "m.sqlite")
        db.init(path)
        self.conn = db.connect(path)
        self.now = 1_800_000_000
        self.k = 2
        with db.tx(self.conn):
            for a in APPROVERS:
                self.conn.execute("INSERT INTO enrolled_keys VALUES (?, ?, ?)", (a, raw_public_key(), self.now))
            petitions.create_item(self.conn, self.now, "user:quinn", "item", "Item (fictional)")
        self._reseal()
        self.petitions: dict[str, dict] = {}
        self.terminal_seen: dict[str, str] = {}
        self.approvals: dict[str, set] = {}

    def _call(self, fn, *args):
        try:
            with db.tx(self.conn):
                return fn(self.conn, self.now, *args)
        except Rejected as e:
            return e

    def _reseal(self):
        self.version = str(uuid.uuid4())
        with db.tx(self.conn):
            petitions.activate_seal_version(
                self.conn, self.now, "user:quinn", "item", self.version, self.k, APPROVERS,
                fake_sym(), fake_sym(), {a: fake_envelope() for a in APPROVERS})

    def teardown(self):
        self.conn.close()

    @rule(requester=st.sampled_from(OTHERS + APPROVERS), window=st.integers(60, 4000))
    def open(self, requester, window):
        r = self._call(petitions.create_petition, requester, "item", "incident (fictional)", window, raw_public_key())
        assert not isinstance(r, Rejected)
        self.petitions[r["petition_id"]] = {"requester": requester, "version": self.version}
        self.approvals[r["petition_id"]] = set()

    @precondition(lambda self: self.petitions)
    @rule(data=st.data(), approver=st.sampled_from(APPROVERS + OTHERS))
    def approve(self, data, approver):
        pid = data.draw(st.sampled_from(sorted(self.petitions)))
        before = self._state(pid)
        r = self._call(petitions.approve, approver, pid, fake_envelope())
        if not isinstance(r, Rejected) and r["counted"]:
            assert approver in APPROVERS and before == "Open"
            self.approvals[pid].add(approver)

    @precondition(lambda self: self.petitions)
    @rule(data=st.data(), who=st.sampled_from(APPROVERS + ["user:quinn", "user:kit"]))
    def deny(self, data, who):
        pid = data.draw(st.sampled_from(sorted(self.petitions)))
        self._call(petitions.deny, who, pid)

    @rule()
    def reseal(self):
        self._reseal()

    @rule(seconds=st.integers(1, 2000))
    def advance(self, seconds):
        self.now += seconds

    @precondition(lambda self: self.petitions)
    @rule(data=st.data(), caller=st.sampled_from(OTHERS + APPROVERS))
    def retrieve(self, data, caller):
        pid = data.draw(st.sampled_from(sorted(self.petitions)))
        info = self.petitions[pid]
        before = self._state(pid)
        r = self._call(petitions.release, caller, pid)
        if isinstance(r, Rejected):
            return
        assert caller == info["requester"]
        assert before in ("Approved", "Released")
        assert len(self.approvals[pid]) >= self.k
        assert info["version"] == self.version
        assert len(r["envelopes"]) == self.k
        assert len({e["approver_id"] for e in r["envelopes"]}) == self.k

    @precondition(lambda self: self.petitions)
    @rule(data=st.data())
    def retrieve_as_requester(self, data):
        pid = data.draw(st.sampled_from(sorted(self.petitions)))
        before = self._state(pid)
        r = self._call(petitions.release, self.petitions[pid]["requester"], pid)
        if not isinstance(r, Rejected):
            assert before in ("Approved", "Released")
            assert len(self.approvals[pid]) >= self.k
            assert self.petitions[pid]["version"] == self.version
            assert len(r["envelopes"]) == self.k

    def _state(self, pid):
        return self.conn.execute("SELECT state FROM bg_petitions WHERE petition_id = ?", (pid,)).fetchone()["state"]

    @invariant()
    def terminal_states_stay(self):
        for pid in self.petitions:
            s = self._state(pid)
            if pid in self.terminal_seen:
                assert s == self.terminal_seen[pid]
            elif s in TERMINAL:
                self.terminal_seen[pid] = s

    @invariant()
    def counts_are_distinct_eligible(self):
        for pid, approvers in self.approvals.items():
            rows = self.conn.execute("SELECT approver_id FROM bg_approvals WHERE petition_id = ?", (pid,)).fetchall()
            ids = [r["approver_id"] for r in rows]
            assert len(ids) == len(set(ids)) == len(approvers)
            assert set(ids) <= set(APPROVERS)
            assert len(ids) <= self.k

    @invariant()
    def superseded_are_invalidated_or_closed(self):
        for pid, info in self.petitions.items():
            if info["version"] != self.version:
                assert self._state(pid) in TERMINAL


TestPetitionMachine = PetitionMachine.TestCase
TestPetitionMachine.settings = settings(
    max_examples=60, stateful_step_count=30, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)
