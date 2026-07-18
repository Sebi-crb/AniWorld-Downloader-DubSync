# DubSync Integration Plan

## Context

[Project-Idea.md](Project-Idea.md) proposes **DubSync**: take a folder of high-quality
video files (e.g. Blu-ray rips from Nyaa that carry only JP/EN audio) and losslessly
graft a **German dub** audio track — extracted from an AniWorld/SerienStream stream —
into each matching file as a secondary, correctly language-tagged track. Today the repo
can *download* a German dub muxed with web-quality video, but there is no way to marry a
web-sourced dub to an external, archive-quality video. This plan adds that.

Decisions locked in with the user:
- **Automatic audio alignment** (not a manual-offset-only v1). The alignment method itself
  is the main design question and is planned below; manual offset remains as an override/fallback.
- **Include the Web UI** (settings defaults + an enqueue path + queue job type).
- **Dedicated flag on the existing `aniworld` command** (no subcommands; matches current argparse).

The good news from exploration: the ffmpeg muxing/progress/finalize/probe machinery and the
German-stream resolution (with provider fallback) already exist and are directly reusable.
The genuinely new work is (1) an alignment engine and (2) scene-release filename matching.

---

## Architecture: new `src/aniworld/dubsync/` package

DubSync operates on **(AniWorld source URL) × (local video directory)** — two inputs — which
does not fit the single-object `run_action(obj, action)` model. So it lives in its own package,
orchestrated by a pipeline, and is invoked via a dedicated flag (CLI) or queue source (web).

```
src/aniworld/dubsync/
  __init__.py      # exports run_dubsync(...) pipeline entry
  matcher.py       # NEW: parse local filenames -> (season, episode) -> pair with AniWorld episodes
  extract.py       # extract German audio from an AniWorld episode (lossless -c:a copy)
  align.py         # NEW: automatic offset detection (see "Alignment design")
  remux.py         # mux target video + delayed German audio -> tagged output
  pipeline.py      # orchestrates match -> extract -> align -> remux -> cleanup, reports progress
```

### Data flow per episode
1. **Match** local file `…/Evangelion - 01 …mkv` to AniWorld episode #1 (via `matcher.py`).
2. **Preflight**: `check_downloaded(target)` — skip if a `deu` audio track already present.
3. **Extract** the German dub audio from the AniWorld episode to a temp file, `-c:a copy` (lossless).
4. **Align**: detect the offset between the extracted dub and the target's existing audio (`align.py`).
5. **Remux**: `ffmpeg` target video (all streams) + `-itsoffset <offset>` German audio, `-c copy`,
   tag the new track `language=deu`, write to temp, then `_finalize_episode` onto the output path.
6. **Cleanup** (opt-in): replace original in place / delete temps.

---

## Alignment design (the key research area)

**Problem.** The Blu-ray carries JP/EN dialogue; the web track carries German dialogue — different
speech, so you can't correlate dialogue directly. Two kinds of misalignment occur:
- **Constant offset** — different intro/pre-roll trimming, black frames (fixable losslessly via `-itsoffset`).
- **Linear drift** — German dubs are frequently PAL-sourced (25 fps vs 23.976 fps ≈ 4% faster), so the
  offset grows across the episode. A single `-itsoffset` cannot fix this; it needs a tempo change (`atempo`),
  which **re-encodes audio and breaks "lossless."**

**Recommended method — shared music/SFX-bed cross-correlation (constant offset):**
Even though dialogue differs, a dub reuses the same **music and sound-effects bed**. Correlating a
loudness/onset envelope of the two tracks locks onto those shared events:
1. With ffmpeg, decode both the German dub and **one** target audio track (prefer JP, else first audio)
   to mono PCM at a low rate (e.g. 8 kHz).
2. Compute a coarse energy/onset envelope per track (numpy; downsampled — robust to *which* language
   the dialogue is, because loud musical hits/SFX dominate the envelope).
3. FFT cross-correlate the two envelopes; the peak lag = global offset. Peak sharpness = confidence.
4. If confidence < threshold → fall back to the user's manual `--dubsync-offset` (or 0) and flag the
   episode in the report as "low-confidence, verify manually."

This is the same family of technique proven by `ffsubsync`; "correlate against the JP track" is one
instance, but the signal is really the *shared non-dialogue bed*, so it does not depend on JP specifically.

**Drift handling (Phase 2 of alignment, opt-in):** run the correlation in a window near the **start**
and near the **end**; if the two offsets differ materially, derive a tempo ratio, apply `atempo` (this
re-encodes the German audio only — original video/other audio stay copy). Gate behind
`--dubsync-allow-resample` since it sacrifices bit-exactness of the dub track.

**Keep it pluggable.** `align.py` exposes `detect_offset(dub_path, ref_path) -> AlignResult(offset, confidence)`
so the correlation implementation can be swapped without touching the pipeline. Ship the correlation
aligner + a `--dubsync-offset` manual override + a `--dubsync-dry-run` that prints matches and detected
offsets **without writing** — essential for building trust in the aligner before it edits archive files.

**New dependency:** `numpy` (pure-numpy FFT correlation avoids pulling in scipy). Add to `pyproject.toml`.

---

## Reused utilities (do not reinvent)

| Need | Reuse | Location |
| --- | --- | --- |
| Run ffmpeg + progress + stall-kill | `_run_ffmpeg_with_progress(node, ...)` | [common.py:333](src/aniworld/models/common/common.py#L333) |
| Multi-input `-c copy` mux skeleton | pattern in `download()` | [common.py:1136](src/aniworld/models/common/common.py#L1136), [:1209](src/aniworld/models/common/common.py#L1209) |
| Container-aware finalize/remux | `_finalize_episode(temp, out, label)` | [common.py:539](src/aniworld/models/common/common.py#L539) |
| Probe existing tracks/langs (skip if `deu` present) | `check_downloaded(path)` | [common.py:100](src/aniworld/models/common/common.py#L100) |
| German stream URL w/ provider fallback | `_resolve_stream_url_with_fallback(self, "DubSync")` | [common.py:270](src/aniworld/models/common/common.py#L270) |
| Audio-only extraction pattern (switch `acodec=copy`) | `download()` need_audio branch | [common.py:1152](src/aniworld/models/common/common.py#L1152) |
| Web progress snapshot | `get_ffmpeg_progress()` | [common.py:303](src/aniworld/models/common/common.py#L303) |
| Filename-safe cleaning | `clean_title()` | [common.py:51](src/aniworld/models/common/common.py#L51) |
| Language codes (`deu`), presets | `LANG_CODE_MAP`, `LANG_KEY_MAP` | [config.py:325](src/aniworld/config.py#L325) |
| Enumerate source episodes (num/title) | `AniworldSeason.episodes` | [season.py:96](src/aniworld/models/aniworld_to/season.py#L96) |
| Naming-template split/format (for output paths) | pattern in hanime episode | [hanime_tv/episode.py:246](src/aniworld/models/hanime_tv/episode.py#L246) |

**Adaptations:** extraction uses `acodec="copy"` (lossless) instead of `acodec=video_codec`; the new dub
track is tagged `metadata:s:a:1` (secondary), and remux uses explicit `-map 0 -map 1:a` so the original
video/audio come first and the dub is appended; add `ffmpeg.input(dub, itsoffset=offset)` (the
`ffmpeg.input(..., **kwargs)` threading already exists).

---

## Implementation order

**Phase 1 — Core remux engine (no alignment yet).** Prove the mux end-to-end with a manual offset.
- `matcher.py`: parse a directory of videos → `[(path, season, episode)]`. Handle common scene/BD naming
  (`Show - 01`, `S01E01`, `01v2`, ` - 12 (1080p)`, absolute vs seasonal numbering). Return unmatched files
  for reporting. (Net-new; closest existing regex refs: hanime episode-number extraction, `web/planned.py:_clean_title`.)
- `extract.py`: given an AniworldEpisode with `selected_language="German Dub"`, resolve stream via
  `_resolve_stream_url_with_fallback`, ffmpeg `-map 0:a:0 -c:a copy` → temp `.mka`/`.mkv`.
- `remux.py`: target video + dub → `-map 0 -map 1:a -c copy`, tag `deu` on the new track, via
  `_run_ffmpeg_with_progress` + `_finalize_episode`.
- `pipeline.py`: `run_dubsync(source_url, target_dir, offset=0.0, ...)` — enumerate `AniworldSeason.episodes`,
  pair via matcher, extract→remux with a **fixed** `offset`, honor `check_downloaded` skip, `--dubsync-dry-run`.

**Phase 2 — Automatic alignment.**
- `align.py`: `detect_offset(dub_path, ref_path)` (envelope FFT cross-correlation + confidence).
- Wire into `pipeline.py`: auto-detect per episode; manual `--dubsync-offset` overrides; low-confidence
  falls back + is flagged. Add optional drift/`atempo` path behind `--dubsync-allow-resample`.
- Add `numpy` to `pyproject.toml`.

**Phase 3 — CLI surface.** In [arguments.py](src/aniworld/arguments.py) add a "DubSync" arg group:
`--dubsync-target <dir>`, `--dubsync-offset <sec>`, `--dubsync-auto-align/--no-…` (default on),
`--dubsync-allow-resample`, `--dubsync-cleanup`, `--dubsync-dry-run`. Follow the existing pattern:
propagate to `ANIWORLD_DUBSYNC_*` env in the post-parse block ([arguments.py:316](src/aniworld/arguments.py#L316)).
In [entry.py](src/aniworld/entry.py) `aniworld()`, right after `parse_args()`, branch: if
`args.dubsync_target` is set → validate the positional URL is an AniWorld/SerienStream season/series →
call `run_dubsync(...)` and return (before the normal action dispatch).

**Phase 4 — Config & docs.** Add an `# === DubSync Settings ===` block to
[.env.example](src/aniworld/.env.example) (`ANIWORLD_DUBSYNC_TARGET_DIR`, `_OFFSET`, `_AUTO_ALIGN`,
`_ALLOW_RESAMPLE`, `_CLEANUP`, `_AUDIO_LANG=German Dub`); read via `os.getenv` in the pipeline.
`merge_env` auto-propagates the new keys to existing users. Document the feature in README.

**Phase 5 — Web UI.**
- **Settings defaults**: add a DubSync section to [settings.html](src/aniworld/web/templates/settings.html)
  (enable toggle, default target dir, auto-align toggle, offset), savers in
  [settings.js](src/aniworld/web/static/settings.js), and read/write keys in `api_settings` GET
  ([app.py:2082](src/aniworld/web/app.py#L2082)) + PUT ([app.py:2139](src/aniworld/web/app.py#L2139)),
  following the `enable_htv`/`sync_schedule` pattern. Persist via `persist_env_values` if they must survive restart.
- **Enqueue + job type**: reuse the `download_queue` table with `source="dubsync"`; store `target_dir`
  and `offset` (JSON blob in the `episodes` column or two small migration-added columns, mirroring how
  `source` is already used). Add a minimal enqueue form (series URL + target dir + offset) on a small
  `/dubsync` page or the queue page. In `_queue_worker` ([app.py:462](src/aniworld/web/app.py#L462)),
  branch on `item["source"] == "dubsync"` → call `run_dubsync(...)` instead of `episode.download()`,
  reusing `update_queue_progress`/`get_ffmpeg_progress` for UI progress.

---

## Risks / call-outs
- **PAL 4% drift** is the real accuracy risk; constant-offset alignment won't fully fix drifted dubs.
  Mitigate with the two-window drift check + opt-in `atempo` (documented as lossy for the dub track only).
- **Lossless caveat**: pure offset stays `-c:a copy`; resampling for drift re-encodes the dub. Keep it opt-in.
- **Episode-number ambiguity**: specials/OVAs, absolute vs per-season numbering, movies. Matcher must report
  unmatched/ambiguous rather than guess; `--dubsync-dry-run` lets the user verify before any write.
- **Editing archive files**: never write in place without a temp+replace; default to writing a new file and
  make in-place/cleanup explicit (`--dubsync-cleanup`).

---

## Verification
- **Unit — matcher** ([tests/](tests/), pytest already present): feed representative scene/BD filenames,
  assert `(season, episode)` extraction and that junk files land in "unmatched."
- **Unit — aligner**: synthesize two mono signals sharing an impulse/music bed, shift one by a known N ms,
  assert `detect_offset` returns ≈N within tolerance and high confidence; assert a noise-only pair returns
  low confidence.
- **Integration — remux**: on a tiny sample `.mkv` + a short audio file, run `remux.py`; `ffprobe` the output
  and assert a second audio stream exists tagged `language=deu` and stream order is video, orig-audio, dub.
- **End-to-end (manual)**: point `aniworld <small-season-url> --dubsync-target <dir-of-dummy-videos> --dubsync-dry-run`
  → confirm the match table + detected offsets; then without `--dry-run` confirm files gain the `deu` track and
  `check_downloaded` skips a second run.
- **Web**: enqueue a DubSync job, watch it flow through `_queue_worker`, confirm status→completed and progress updates.
