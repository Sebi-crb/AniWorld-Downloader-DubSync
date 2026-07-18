# Project Idea: DubSync - Multi-Audio Anime Remuxer

An automated pipeline designed to bridge the gap between high-quality video releases (e.g., Japanese/English Blu-ray rips from Nyaa.si) and regional German dubs streamed via platforms like AniWorld. 

The tool extracts audio tracks from german streams and seamlessly remuxes them as secondary language tracks into pristine archive-quality video containers, entirely without lossy re-encoding.

---

## 💡 The Problem
Anime enthusiasts face a dilemma:
1. **Streaming Sites (AniWorld/S.to):** Contain localized German dubs but often feature compressed, lower-bitrate video streams.
2. **Torrent Trackers (Nyaa):** Provide stunning, high-bitrate, multi-GB Blu-ray encodes, but they rarely include regional European audio tracks like German.

Manually downloading both, extracting the audio, calculating the offset delays, and running complex `ffmpeg` commands for a 24-episode season is tedious and time-consuming.

## 🚀 The Solution
**DubSync** functions either as an extension framework for `AniWorld-Downloader` or a standalone post-processing script. It automates the matching, delay synchronization, and lossless remuxing of downloaded audio files into a targeted folder of high-quality video files.

---

## 🛠️ Feature Roadmap

### Phase 1: Core CLI & Remuxing Engine (Standalone Script)
* [ ] **Intelligent File Matching:** Parse filenames using regex to automatically pair `Evangelion - 01 (Nyaa).mkv` with `Evangelion - 01 (AniWorld).mp3`.
* [ ] **Lossless Stream Muxing:** Utilize `ffmpeg` backend execution to copy the original video stream (`-c:v copy`) and insert the new audio stream seamlessly.
* [ ] **Language Metadata Tagging:** Automatically inject the correct ISO language codes (e.g., setting the newly added track metadata to `ger` / German) so media players like Plex, Jellyfin, and VLC recognize it instantly.

### Phase 2: Synchronization & Quality of Life
* [ ] **Global & Per-Episode Audio Offsets:** Implement an `-itsoffset` handler to adjust for web-stream intros or TV-cut variations (e.g., delaying audio by `+1.25s` or `-0.5s` to ensure lipsync perfection).
* [ ] **Multi-Format Cleanup:** Automatically remove the bloated source web-video file once the audio is safely extracted and merged, preserving hard drive space.

### Phase 3: Integration (Optional Fork)
* [ ] **AniWorld-Downloader UI Toggle:** Integrate directly into the Web UI or config schema of the `phoenixthrush/AniWorld-Downloader` repository, adding a `"Target Existing Video Directory"` field.

---

## 📐 Architecture & Workflow