"""Unit tests for DubSync's dub-extraction retry/provider-rotation loop.

Hosters sign their HLS links against the requesting IP/session and expire them
aggressively, so an extraction that resolves fine and *then* 403s its segments
is the common transient failure -- not a dead episode. These tests drive
``extract_dub_audio`` with a fake episode and a fake ffmpeg so the retry budget,
the rotation to the next provider, the fresh re-resolve per attempt, and the
cleanup of truncated output are all pinned without touching the network.
"""

from pathlib import Path

import pytest

from aniworld.models.aniworld_to.dubsync import extract as extract_mod
from aniworld.models.aniworld_to.dubsync.extract import (
    MAX_ATTEMPTS_PER_PROVIDER,
    extract_dub_audio,
)


class FakeEpisode:
    """Minimal stand-in for an episode model.

    ``selected_provider`` must be a real property with a setter: that is how
    ``_set_selected_provider`` detects an episode it is allowed to re-point at
    another host.
    """

    def __init__(self, providers):
        self._providers = list(providers)
        self._selected = self._providers[0]
        self.selected_language = None
        self.resolve_calls = []

    def provider_attempt_order(self):
        return tuple(self._providers)

    @property
    def selected_provider(self):
        return self._selected

    @selected_provider.setter
    def selected_provider(self, value):
        self._selected = value

    @property
    def stream_url(self):
        # Each read stands for a freshly signed link, which is exactly what a
        # retry needs; the token in the query string makes that visible.
        self.resolve_calls.append(self._selected)
        return (
            f"https://cdn.example/{self._selected}/master.m3u8"
            f"?t=token{len(self.resolve_calls)}"
        )


class _FakeNode:
    def __init__(self, dest):
        self.dest = dest


class _FakeInput:
    def __init__(self, url, **kwargs):
        self.url = url
        self.kwargs = kwargs

    def output(self, dest, **_kwargs):
        return _FakeNode(Path(dest))


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    """Replace ffmpeg graph construction and keep the retry backoff instant."""

    monkeypatch.setattr(extract_mod.ffmpeg, "input", _FakeInput)
    monkeypatch.setattr(extract_mod.time, "sleep", lambda _s: None)


def _install_runner(monkeypatch, behaviour):
    """Install a fake ffmpeg runner driven by *behaviour*.

    *behaviour* is called with the 1-based run index and returns ``None`` to
    succeed (writing a plausible output file) or an exception to raise.
    """

    runs = []

    def _run(node, label=""):  # noqa: ARG001 - label is cosmetic
        runs.append(node.dest)
        outcome = behaviour(len(runs))
        if outcome is not None:
            # A real ffmpeg failure often leaves a truncated file behind.
            node.dest.write_bytes(b"partial")
            raise outcome
        node.dest.write_bytes(b"audio")
        return None

    monkeypatch.setattr(extract_mod, "_run_ffmpeg_with_progress", _run)
    return runs


def test_succeeds_without_retrying(tmp_path, monkeypatch, fake_ffmpeg):
    episode = FakeEpisode(["VOE", "Vidmoly"])
    runs = _install_runner(monkeypatch, lambda _n: None)
    dest = tmp_path / "ep.deu.mka"

    result_path, provider = extract_dub_audio(episode, dest, label="ep")

    assert (result_path, provider) == (dest, "VOE")
    assert len(runs) == 1
    assert episode.resolve_calls == ["VOE"]
    assert dest.read_bytes() == b"audio"
    assert episode.selected_language == "German Dub"


def test_retries_same_provider_with_a_fresh_url(tmp_path, monkeypatch, fake_ffmpeg):
    """A 403 partway through is transient: the next attempt re-resolves."""

    episode = FakeEpisode(["VOE", "Vidmoly"])
    runs = _install_runner(
        monkeypatch,
        lambda n: RuntimeError("HTTP error 403 Forbidden") if n == 1 else None,
    )
    dest = tmp_path / "ep.deu.mka"

    _, provider = extract_dub_audio(episode, dest, label="ep")

    assert provider == "VOE"
    assert len(runs) == 2
    # Two attempts, two distinct signed URLs -- not a reused dead token.
    assert episode.resolve_calls == ["VOE", "VOE"]


def test_rotates_to_next_provider_after_exhausting_the_first(
    tmp_path, monkeypatch, fake_ffmpeg
):
    episode = FakeEpisode(["VOE", "Vidmoly"])
    fail_count = MAX_ATTEMPTS_PER_PROVIDER
    runs = _install_runner(
        monkeypatch,
        lambda n: RuntimeError("403 Forbidden") if n <= fail_count else None,
    )
    dest = tmp_path / "ep.deu.mka"

    _, provider = extract_dub_audio(episode, dest, label="ep")

    assert provider == "Vidmoly"
    assert len(runs) == MAX_ATTEMPTS_PER_PROVIDER + 1
    assert episode.resolve_calls == ["VOE"] * MAX_ATTEMPTS_PER_PROVIDER + ["Vidmoly"]
    assert dest.read_bytes() == b"audio"


def test_raises_listing_every_provider_when_all_fail(
    tmp_path, monkeypatch, fake_ffmpeg
):
    episode = FakeEpisode(["VOE", "Vidmoly"])
    runs = _install_runner(monkeypatch, lambda _n: RuntimeError("403 Forbidden"))
    dest = tmp_path / "ep.deu.mka"

    with pytest.raises(RuntimeError) as excinfo:
        extract_dub_audio(episode, dest, label="ep")

    message = str(excinfo.value)
    assert "VOE" in message and "Vidmoly" in message
    assert len(runs) == 2 * MAX_ATTEMPTS_PER_PROVIDER
    # The truncated output of the last failed attempt must not survive: the
    # caller would otherwise align and remux a partial dub.
    assert not dest.exists()


def test_resolution_failure_is_retried_too(tmp_path, monkeypatch, fake_ffmpeg):
    """The old code retried nothing; resolution errors must rotate as well."""

    class ResolveFailsForVOE(FakeEpisode):
        @property
        def stream_url(self):
            self.resolve_calls.append(self._selected)
            if self._selected == "VOE":
                raise RuntimeError("could not extract direct link")
            return "https://cdn.example/ok/master.m3u8"

    episode = ResolveFailsForVOE(["VOE", "Vidmoly"])
    runs = _install_runner(monkeypatch, lambda _n: None)
    dest = tmp_path / "ep.deu.mka"

    _, provider = extract_dub_audio(episode, dest, label="ep")

    assert provider == "Vidmoly"
    assert len(runs) == 1  # ffmpeg never ran for VOE
    assert episode.resolve_calls == ["VOE"] * MAX_ATTEMPTS_PER_PROVIDER + ["Vidmoly"]
