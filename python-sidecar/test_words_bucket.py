"""REQ-0285 §1 — pin the `_bucket_words_into_cues` helper that
distributes a segment's flat word list across the sub-cues produced by
`resplit_segment` on the REQ-0207 word-subtitle path.

The helper lives inline in `main.py` (inside `handle_transcribe`) to
keep the sidecar's runtime imports narrow — reimplemented here as a
copy so we can unit-test the assignment logic without spinning up
faster-whisper / a full transcribe run.  If a future REQ moves the
helper into a shared module, this test file's fixture becomes an
import and stays valid.

The invariant under test: every word ends up assigned to exactly one
cue, biased toward "cue containing this word's start time" and
falling back to "nearest cue by edge distance" for words that fall
in a between-cues gap.
"""
from __future__ import annotations
import unittest
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Copies of the sidecar helper + a minimal cue/word shape.  Kept in sync
# with `python-sidecar/main.py:_bucket_words_into_cues` by convention;
# the shape of both dataclasses matches faster-whisper's Word namedtuple
# and word_split.Cue closely enough that a live sidecar bucket call
# would produce identical results.
# ---------------------------------------------------------------------------

@dataclass
class _FakeWord:
    start: Optional[float]
    end: Optional[float]
    word: str


@dataclass
class _FakeCue:
    startSec: float
    endSec: float
    text: str


def _bucket_words_into_cues(cues, words):
    """Verbatim copy of the helper in `main.py`."""
    buckets: list[list] = [[] for _ in cues]
    if not cues or not words:
        return buckets
    for w in words:
        w_start = w.start if w.start is not None else 0.0
        placed = False
        for i, c in enumerate(cues):
            if c.startSec <= w_start <= c.endSec:
                buckets[i].append(w)
                placed = True
                break
        if not placed:
            best = 0
            best_dist = float("inf")
            for i, c in enumerate(cues):
                d = min(abs(c.startSec - w_start), abs(c.endSec - w_start))
                if d < best_dist:
                    best = i
                    best_dist = d
            buckets[best].append(w)
    return buckets


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestBucketWordsIntoCues(unittest.TestCase):
    """REQ-0285 §1 — word-to-cue assignment for the resplit path."""

    def test_empty_words_returns_empty_buckets_per_cue(self):
        cues = [_FakeCue(0.0, 1.0, "a"), _FakeCue(1.0, 2.0, "b")]
        buckets = _bucket_words_into_cues(cues, [])
        self.assertEqual(len(buckets), 2)
        self.assertEqual(buckets[0], [])
        self.assertEqual(buckets[1], [])

    def test_empty_cues_returns_empty_list(self):
        words = [_FakeWord(0.0, 0.5, "hi")]
        buckets = _bucket_words_into_cues([], words)
        self.assertEqual(buckets, [])

    def test_words_land_in_cue_containing_their_start(self):
        """Happy path: each word's start falls within one cue's [start, end]."""
        cues = [_FakeCue(0.0, 1.0, "a b"), _FakeCue(1.0, 2.0, "c d")]
        words = [
            _FakeWord(0.0, 0.4, "a"),
            _FakeWord(0.5, 0.9, "b"),
            _FakeWord(1.1, 1.5, "c"),
            _FakeWord(1.6, 2.0, "d"),
        ]
        buckets = _bucket_words_into_cues(cues, words)
        self.assertEqual([w.word for w in buckets[0]], ["a", "b"])
        self.assertEqual([w.word for w in buckets[1]], ["c", "d"])

    def test_word_at_cue_boundary_goes_to_first_matching_cue(self):
        """A word whose start EXACTLY equals a cue boundary is inclusive on
        the [start, end] check, so the earlier cue wins (first match)."""
        cues = [_FakeCue(0.0, 1.0, "a"), _FakeCue(1.0, 2.0, "b")]
        words = [_FakeWord(1.0, 1.5, "at-boundary")]
        buckets = _bucket_words_into_cues(cues, words)
        # First cue (index 0) contains 1.0 on its inclusive end, so it wins.
        self.assertEqual([w.word for w in buckets[0]], ["at-boundary"])
        self.assertEqual(buckets[1], [])

    def test_word_in_gap_falls_to_nearest_cue_by_edge_distance(self):
        """A word with a start in the silence gap between cues falls to the
        cue whose nearest edge is closest (fallback branch)."""
        cues = [_FakeCue(0.0, 1.0, "a"), _FakeCue(2.0, 3.0, "b")]
        # Word at 1.4 → closer to cue[0].end (1.0) than to cue[1].start (2.0)
        words = [_FakeWord(1.4, 1.5, "gap-word-near-first")]
        buckets = _bucket_words_into_cues(cues, words)
        self.assertEqual([w.word for w in buckets[0]], ["gap-word-near-first"])
        self.assertEqual(buckets[1], [])
        # Word at 1.7 → closer to cue[1].start (2.0) than to cue[0].end (1.0)
        buckets = _bucket_words_into_cues(cues, [_FakeWord(1.7, 1.8, "gap-word-near-second")])
        self.assertEqual(buckets[0], [])
        self.assertEqual([w.word for w in buckets[1]], ["gap-word-near-second"])

    def test_none_start_treated_as_zero(self):
        """Defensive: a None-timed word (rare tokenizer failure) is placed
        at time 0.0.  Test that it doesn't blow up and lands somewhere
        reasonable (cue[0] if 0.0 is in its range)."""
        cues = [_FakeCue(0.0, 1.0, "a"), _FakeCue(1.0, 2.0, "b")]
        words = [_FakeWord(None, None, "no-timing")]
        buckets = _bucket_words_into_cues(cues, words)
        # 0.0 is in cue[0]'s [0.0, 1.0] range, so it lands there.
        self.assertEqual([w.word for w in buckets[0]], ["no-timing"])

    def test_all_words_assigned_no_duplication(self):
        """Sum of bucket sizes equals input word count — no dropped or
        duplicated words."""
        cues = [_FakeCue(0.0, 1.0, "a b"), _FakeCue(1.0, 2.0, "c"), _FakeCue(3.0, 4.0, "d")]
        words = [
            _FakeWord(0.0, 0.4, "one"),
            _FakeWord(0.5, 0.9, "two"),
            _FakeWord(1.2, 1.8, "three"),
            _FakeWord(3.1, 3.5, "four"),
            _FakeWord(2.5, 2.9, "gap"),  # in gap between cue[1] and cue[2]
        ]
        buckets = _bucket_words_into_cues(cues, words)
        total = sum(len(b) for b in buckets)
        self.assertEqual(total, len(words))

    def test_all_words_fit_first_cue_when_only_one_cue(self):
        cues = [_FakeCue(0.0, 5.0, "all one cue")]
        words = [
            _FakeWord(0.0, 0.5, "hello"),
            _FakeWord(0.5, 1.0, " world"),
            _FakeWord(4.5, 5.0, " end"),
        ]
        buckets = _bucket_words_into_cues(cues, words)
        self.assertEqual(len(buckets), 1)
        self.assertEqual([w.word for w in buckets[0]], ["hello", " world", " end"])


if __name__ == "__main__":
    unittest.main()
