"""REQ-0207 — word-level subtitle re-split for the experimental word-subtitle
feature.

Kept as a standalone module so `main.py`'s legacy transcribe path is not
touched.  The pure function `resplit_words_into_cues` takes the flat word
sequence emitted by `faster-whisper` (with `word_timestamps=True`) and
returns a list of cues that share the same `{startSec, endSec, text}` shape
the sidecar already emits on the `segment` IPC event, so the renderer sees
no shape change.

Design source: RES-0205 §6 (which itself cites the stable-ts / whisperX
regroup pipeline).  Parameters are module-level constants so an owner can
tune them by editing this file only; nothing else in the tree references
them by name.

CRITICAL: this module is only reached when `wordSubtitle=True`.  For the
default off path `main.py` never imports it, and the byte-identical
guarantee therefore reduces to "off path does not touch this file at all."
Any behavioural change in this module is scoped to on-only, by construction.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence


# ---------------------------------------------------------------------------
# Tuneable parameters.  Owner may adjust after real-audio observation.
# Rationale for each value is in RES-0205 §6.2.
# ---------------------------------------------------------------------------

WORD_SUB_MAX_WORDS: int = 3
"""Maximum words per cue.  REQ-0207 spec says '1–3 word chunks'."""

WORD_SUB_SILENCE_SEC: float = 0.35
"""Inter-word silence gap that forces a cue boundary.  RES-0205 §1.3 measured
0.24 s as connected speech and 0.4 s as sentence-final pause; 0.35 s sits in
the middle and biases toward the CapCut-style rapid-cut feel."""

WORD_SUB_MAX_DUR_SEC: float = 1.5
"""Hard cap on cue duration.  Three long words (~0.5 s each) shouldn't stretch
past 1.5 s or the cue becomes hard to read in short-form contexts."""

WORD_SUB_MIN_DUR_SEC: float = 0.25
"""Minimum cue duration.  Cues below this are merged into their predecessor
to prevent single-frame flicker.  Value chosen to match short-form caption
industry norms — well below the 1.0 s standard subtitle floor, which would
defeat the point of a word-by-word feature."""

# Sentence-final punctuation.  Both half-width and full-width forms so a user
# who enables the flag on JA audio (unsupported but not blocked per REQ) still
# gets sentence boundaries respected where the tokenizer surfaces them.
_SENTENCE_FINAL_PUNCT: tuple[str, ...] = ('.', '!', '?', '。', '！', '？')


# ---------------------------------------------------------------------------
# Data types.  These deliberately mirror faster-whisper's `Word` shape (which
# is a NamedTuple in the library) so callers can pass live results in
# directly, and mirror the sidecar's per-cue emit dict so the caller can
# `send({event: 'segment', segment: cue})` without transforming.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WordSpan:
    """One faster-whisper word.  `start` / `end` may be None on rare tokenizer
    failures (numbers, symbols); the split logic defends against that per
    RES-0205 §6.5 by folding the None-timed word into the previous word."""
    start: Optional[float]
    end: Optional[float]
    word: str  # keeps faster-whisper's leading space, e.g. " Dr."


@dataclass(frozen=True)
class Cue:
    """One output cue.  Mirrors the `{startSec, endSec, text}` shape the
    sidecar's `segment` IPC event has emitted since v1.0."""
    startSec: float
    endSec: float
    text: str

    def duration(self) -> float:
        return self.endSec - self.startSec


# ---------------------------------------------------------------------------
# Core function.
# ---------------------------------------------------------------------------

def _ends_with_sentence_final(word: str) -> bool:
    """`word` may have a trailing space or leading space; strip and inspect."""
    stripped = word.rstrip()
    if not stripped:
        return False
    return stripped[-1] in _SENTENCE_FINAL_PUNCT


def _cue_from_buffer(buffer: Sequence[WordSpan], fallback_start: float) -> Cue:
    """Assemble one Cue from a non-empty buffer.  `fallback_start` is used when
    the first word's start is None (defensive path per RES-0205 §6.5)."""
    assert buffer, "buffer must not be empty"
    first_start = buffer[0].start if buffer[0].start is not None else fallback_start
    # Walk from the tail backward to find the last non-None end.  Under
    # normal input every word has an end, so this is a single lookup.
    last_end: Optional[float] = None
    for w in reversed(buffer):
        if w.end is not None:
            last_end = w.end
            break
    if last_end is None:
        # Every word in the buffer lost its end.  Fall back to first_start
        # so the cue at least has a valid non-negative duration (0).
        last_end = first_start
    text = ''.join(w.word for w in buffer).lstrip()
    return Cue(startSec=first_start, endSec=last_end, text=text)


def resplit_words_into_cues(
    words: Iterable[WordSpan],
    *,
    segment_start_hint: float = 0.0,
) -> List[Cue]:
    """Re-split a flat word sequence into short 1-3 word cues.

    Rules, applied left-to-right (RES-0205 §6.1):
      1. If the current word ends with `. ! ? 。 ！ ？`, emit after this word
         (sentence-final boundary always wins).
      2. Else if the gap between this word's end and the next word's start
         is >= `WORD_SUB_SILENCE_SEC`, emit after this word.
      3. Else if the buffer would exceed `WORD_SUB_MAX_WORDS`, emit before
         this word.
      4. Else if the buffer's duration would exceed `WORD_SUB_MAX_DUR_SEC`,
         emit before this word.

    Post-pass: any cue with `duration < WORD_SUB_MIN_DUR_SEC` is folded into
    its predecessor.  The very first cue has no predecessor and is left
    alone (RES-0205 §6.1).

    `segment_start_hint` is used only for the very rare case where the first
    word's `start` is None; callers should pass their originating segment's
    `start` here.
    """
    word_list = list(words)
    if not word_list:
        return []

    # Defensive: replace None-timed words per §6.5.  A None-timed non-leading
    # word takes the previous word's end as its start AND end (so it appends
    # into the current cue with zero duration contribution).  A None-timed
    # leading word gets `segment_start_hint`.
    normalized: List[WordSpan] = []
    prev_end: Optional[float] = None
    for i, w in enumerate(word_list):
        start = w.start
        end = w.end
        if start is None:
            start = prev_end if prev_end is not None else segment_start_hint
        if end is None:
            end = prev_end if prev_end is not None else start
        normalized.append(WordSpan(start=start, end=end, word=w.word))
        prev_end = end

    cues: List[Cue] = []
    buffer: List[WordSpan] = []

    for i, w in enumerate(normalized):
        buffer.append(w)

        buf_start = buffer[0].start
        buf_end = w.end
        # For the boundary checks below, `duration` and `gap_after_this_word`
        # both assume the last word's end is w.end.
        buf_dur = (buf_end or 0.0) - (buf_start or 0.0)
        gap_after = None
        if i + 1 < len(normalized):
            next_start = normalized[i + 1].start
            if next_start is not None and w.end is not None:
                gap_after = next_start - w.end

        should_emit = False
        # Rule 1: sentence-final punctuation.
        if _ends_with_sentence_final(w.word):
            should_emit = True
        # Rule 2: silence gap.
        elif gap_after is not None and gap_after >= WORD_SUB_SILENCE_SEC:
            should_emit = True
        # Rule 3: word-count cap.
        elif len(buffer) >= WORD_SUB_MAX_WORDS:
            should_emit = True
        # Rule 4: duration cap.
        elif buf_dur >= WORD_SUB_MAX_DUR_SEC:
            should_emit = True

        if should_emit:
            cues.append(_cue_from_buffer(buffer, fallback_start=segment_start_hint))
            buffer = []

    # Any trailing words that never hit an emit condition become the final cue.
    if buffer:
        cues.append(_cue_from_buffer(buffer, fallback_start=segment_start_hint))

    # Post-pass: merge cues shorter than the min duration into their predecessor.
    if len(cues) <= 1:
        return cues

    merged: List[Cue] = [cues[0]]
    for c in cues[1:]:
        if c.duration() < WORD_SUB_MIN_DUR_SEC and merged:
            prev = merged[-1]
            merged[-1] = Cue(
                startSec=prev.startSec,
                endSec=c.endSec,
                text=(prev.text + ' ' + c.text).strip(),
            )
        else:
            merged.append(c)
    return merged


def resplit_segment(
    segment_start: float,
    words: Iterable,
) -> List[Cue]:
    """Convenience adapter for callers holding a live `faster_whisper.transcribe`
    result — those objects have `.start` / `.end` / `.word` attributes rather
    than being `WordSpan` instances.  Converts to `WordSpan` and delegates.

    Used by `main.py` inline for each returned segment; unit tests use
    `resplit_words_into_cues` directly with typed fixtures.
    """
    spans = [
        WordSpan(start=w.start, end=w.end, word=w.word) for w in words
    ]
    return resplit_words_into_cues(spans, segment_start_hint=segment_start)
