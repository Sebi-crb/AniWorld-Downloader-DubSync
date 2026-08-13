"""Lossless extraction of a dub audio track from an AniWorld/SerienStream episode.

Given an episode model object, resolve its stream (with provider fallback) for
the requested language and copy just the audio into a standalone file with
``-c:a copy`` -- no re-encode, so the dub stays bit-exact. The result is later
grafted into the archive-quality target video by :mod:`remux`.
"""

from __future__ import annotations

import time
from pathlib import Path

import ffmpeg

from ....config import PROVIDER_HEADERS_D, logger
from ...common.common import (
    _build_provider_failure_message,
    _get_provider_attempt_order,
    _reset_provider_resolution_cache,
    _run_ffmpeg_with_progress,
    _set_selected_provider,
)

# Mirrors download()'s retry budget: hosters sign their HLS links against the
# requesting IP/session and expire them aggressively, so a 403 mid-transfer is
# transient far more often than it is fatal. Re-resolving yields a fresh token.
MAX_ATTEMPTS_PER_PROVIDER = 3


def _build_input_kwargs(stream_url: str, provider_name: str) -> dict:
    """Mirror ``download()``'s ffmpeg input options: reconnect handling, HLS
    segment-extension allowance, and provider request headers."""

    input_kwargs = {
        "reconnect": 1,
        "reconnect_streamed": 1,
        "reconnect_delay_max": 30,
    }
    if ".m3u8" in (stream_url or "").split("?", 1)[0].lower():
        input_kwargs["allowed_extensions"] = "ALL"

    headers = PROVIDER_HEADERS_D.get(provider_name, {})
    if headers:
        header_list = [f"{k}: {v}" for k, v in headers.items()]
        input_kwargs["headers"] = "\r\n".join(header_list) + "\r\n"

    return input_kwargs


def extract_dub_audio(
    episode,
    dest_path,
    audio_language: str = "German Dub",
    label: str = "",
):
    """Extract *episode*'s ``audio_language`` audio track to ``dest_path``.

    Sets the episode's selected language, then walks the episode's provider
    order -- up to :data:`MAX_ATTEMPTS_PER_PROVIDER` tries each, re-resolving a
    freshly signed stream URL every time -- and copies the first audio stream
    losslessly. Returns ``(dest_path, provider_name)``. Raises ``RuntimeError``
    listing every provider's last error once all of them are exhausted, so the
    caller can report the episode as failed.

    Both resolution and ffmpeg failures are retried: hosters hand back a valid
    URL and *then* 403 the segments, so treating only resolution as retryable
    (as this function used to) turned a transient CDN hiccup into a dead
    episode.
    """

    dest_path = Path(dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    episode.selected_language = audio_language

    provider_errors = {}

    for provider_name in _get_provider_attempt_order(episode):
        try:
            _set_selected_provider(episode, provider_name)
        except Exception as exc:  # noqa: BLE001 - a pinned episode has one provider
            provider_errors[provider_name] = exc
            logger.warning(
                f"[DUBSYNC] cannot switch to provider {provider_name}: {exc}"
            )
            continue

        for attempt in range(1, MAX_ATTEMPTS_PER_PROVIDER + 1):
            try:
                _reset_provider_resolution_cache(episode)
                stream_url = episode.stream_url
                input_kwargs = _build_input_kwargs(stream_url, provider_name)

                logger.debug(
                    f"[DUBSYNC] extracting '{audio_language}' audio via "
                    f"{provider_name} (attempt {attempt}/"
                    f"{MAX_ATTEMPTS_PER_PROVIDER}) -> {dest_path.name}"
                )

                node = ffmpeg.input(stream_url, **input_kwargs).output(
                    str(dest_path),
                    map="0:a:0?",
                    acodec="copy",
                )
                _run_ffmpeg_with_progress(node, label=label)

                return dest_path, provider_name

            except Exception as exc:  # noqa: BLE001 - try the next attempt/provider
                provider_errors[provider_name] = exc
                # A failed pass can leave a truncated .mka behind; the next
                # attempt must not append to or probe that carcass.
                dest_path.unlink(missing_ok=True)

                if attempt < MAX_ATTEMPTS_PER_PROVIDER:
                    logger.warning(
                        f"[DUBSYNC] {provider_name} attempt {attempt}/"
                        f"{MAX_ATTEMPTS_PER_PROVIDER} failed: {exc}; "
                        "retrying with a fresh stream"
                    )
                    time.sleep(attempt)
                else:
                    logger.warning(
                        f"[DUBSYNC] {provider_name} exhausted after "
                        f"{MAX_ATTEMPTS_PER_PROVIDER} attempts: {exc}"
                    )

    if provider_errors:
        raise RuntimeError(
            _build_provider_failure_message("DubSync extraction", provider_errors)
        ) from list(provider_errors.values())[-1]

    raise RuntimeError("DubSync extraction failed: no providers available")
