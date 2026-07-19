// DubSync page: pick a local folder, search the show, auto-select the
// episodes whose files exist locally, queue the graft job.

let dsScan = null; // {files: [{name, season, episode}], unparsed: [name]}
let dsShow = null; // {url, title, poster_url}
let dsSeasons = []; // [{url, season_number, episode_count}]
let dsEpisodes = {}; // season_number -> [{episode_number, url, title_de, title_en, available_languages}]
let dsPairs = {}; // "s:e" -> local filename (auto-match result)
let dsBrowserCurrent = null; // path shown in the browser modal

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3200);
}

function dsT(key, fallback) {
  return typeof window.t === "function" ? window.t(key, fallback) : fallback;
}

// ===== Init =====

async function dsInit() {
  let defaults = {};
  try {
    const resp = await fetch("/api/settings");
    const data = await resp.json();
    defaults = data.dubsync || {};
  } catch (e) {
    /* settings are optional prefill only */
  }

  document.getElementById("dsOffset").value = defaults.offset || "";
  document.getElementById("dsAutoAlign").checked = defaults.auto_align !== "0";
  document.getElementById("dsAllowResample").checked =
    defaults.allow_resample === "1";
  document.getElementById("dsCleanup").checked = defaults.cleanup === "1";

  const folder =
    localStorage.getItem("dubsyncFolder") || defaults.target_dir || "";
  if (folder) {
    document.getElementById("dsFolder").value = folder;
    dsRescan();
  }
  dsUpdateSummary();
}

// ===== Step 1: folder + scan =====

function dsFolderChanged() {
  const folder = document.getElementById("dsFolder").value.trim();
  if (folder) localStorage.setItem("dubsyncFolder", folder);
  dsRescan();
}

async function dsRescan() {
  const folder = document.getElementById("dsFolder").value.trim();
  const info = document.getElementById("dsScanInfo");
  const filesBox = document.getElementById("dsScanFiles");
  dsScan = null;
  filesBox.textContent = "";
  if (!folder) {
    info.textContent = "";
    dsApplyAutoSelection();
    return;
  }

  info.textContent = dsT("dubsync.scanning", "Scanning folder…");
  const recursive = document.getElementById("dsRecursive").checked ? "1" : "0";
  try {
    const resp = await fetch(
      "/api/dubsync/scan?path=" +
        encodeURIComponent(folder) +
        "&recursive=" +
        recursive
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.statusText);
    dsScan = data;
  } catch (e) {
    info.textContent = dsT("dubsync.scan_failed", "Scan failed: ") + e.message;
    dsApplyAutoSelection();
    return;
  }

  const n = dsScan.files.length;
  let text =
    n +
    " " +
    (n === 1
      ? dsT("dubsync.scan_one", "video file recognised")
      : dsT("dubsync.scan_many", "video files recognised"));
  if (dsScan.unparsed.length) {
    text +=
      ", " +
      dsScan.unparsed.length +
      " " +
      dsT("dubsync.scan_unparsed", "without a readable episode number");
  }
  info.textContent = text;

  // Compact chip list of what was parsed, e.g. "S1E01 · file.mkv".
  for (const f of dsScan.files.slice(0, 60)) {
    const chip = document.createElement("span");
    chip.style.cssText =
      "display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;" +
      "border-radius:8px;background:rgba(37,99,235,0.12);color:#9db8e8;" +
      "font-size:0.75rem;";
    const season = f.season === null ? "?" : f.season;
    chip.textContent =
      "S" + season + "E" + String(f.episode).padStart(2, "0") + " · " + f.name;
    filesBox.appendChild(chip);
  }
  if (dsScan.files.length > 60) {
    const more = document.createElement("span");
    more.className = "settings-hint";
    more.textContent = "+" + (dsScan.files.length - 60) + " …";
    filesBox.appendChild(more);
  }

  dsApplyAutoSelection();
}

// ===== Folder browser modal =====

async function dsBrowse(path) {
  const list = document.getElementById("dsBrowserList");
  list.textContent = "";
  try {
    const resp = await fetch(
      "/api/dubsync/browse" +
        (path ? "?path=" + encodeURIComponent(path) : "")
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.statusText);

    dsBrowserCurrent = data.path;
    document.getElementById("dsBrowserPath").textContent = data.path;
    const upBtn = document.getElementById("dsBrowserUp");
    upBtn.disabled = !data.parent;
    upBtn.dataset.parent = data.parent || "";

    const videos = document.getElementById("dsBrowserVideos");
    videos.textContent = data.video_count
      ? data.video_count +
        " " +
        dsT("dubsync.browser_videos", "video file(s) in this folder")
      : "";

    if (!data.dirs.length) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.style.cssText = "padding: 12px";
      empty.textContent = dsT("dubsync.browser_empty", "No subfolders");
      list.appendChild(empty);
    }
    for (const dir of data.dirs) {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:9px 14px;cursor:pointer;color:#c8cad0;font-size:0.88rem;" +
        "border-bottom:1px solid rgba(255,255,255,0.05);";
      row.textContent = "📁 " + dir.name;
      row.onmouseenter = () =>
        (row.style.background = "rgba(255,255,255,0.05)");
      row.onmouseleave = () => (row.style.background = "");
      row.onclick = () => dsBrowse(dir.path);
      list.appendChild(row);
    }
  } catch (e) {
    const err = document.createElement("div");
    err.className = "settings-hint";
    err.style.cssText = "padding: 12px";
    err.textContent = e.message;
    list.appendChild(err);
  }
}

function dsOpenBrowser() {
  document.getElementById("dsBrowserOverlay").style.display = "block";
  dsBrowse(document.getElementById("dsFolder").value.trim() || null);
}

function dsCloseBrowser() {
  document.getElementById("dsBrowserOverlay").style.display = "none";
}

function dsBrowserUp() {
  const parent = document.getElementById("dsBrowserUp").dataset.parent;
  if (parent) dsBrowse(parent);
}

function dsBrowserSelect() {
  if (!dsBrowserCurrent) return;
  document.getElementById("dsFolder").value = dsBrowserCurrent;
  dsCloseBrowser();
  dsFolderChanged();
}

// ===== Step 2: show search =====

async function dsSearchShows() {
  const keyword = document.getElementById("dsSearch").value.trim();
  const site = document.getElementById("dsSite").value;
  const box = document.getElementById("dsResults");
  if (!keyword) return;

  box.textContent = dsT("dubsync.searching", "Searching…");
  try {
    const resp = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, site }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.statusText);

    box.textContent = "";
    if (!data.results.length) {
      box.className = "settings-hint";
      box.textContent = dsT("dubsync.no_results", "No results");
      return;
    }
    box.className = "";
    for (const item of data.results.slice(0, 12)) {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:9px 14px;cursor:pointer;color:#c8cad0;font-size:0.9rem;" +
        "border:1px solid rgba(255,255,255,0.07);border-radius:10px;" +
        "margin-bottom:6px;";
      row.textContent = item.title;
      row.onmouseenter = () =>
        (row.style.background = "rgba(255,255,255,0.05)");
      row.onmouseleave = () => (row.style.background = "");
      row.onclick = () => dsSelectShow(item);
      box.appendChild(row);
    }
  } catch (e) {
    box.className = "settings-hint";
    box.textContent = dsT("dubsync.search_failed", "Search failed: ") + e.message;
  }
}

async function dsSelectShow(item) {
  dsShow = { url: item.url, title: item.title, poster_url: "" };
  dsSeasons = [];
  dsEpisodes = {};
  dsPairs = {};

  document.getElementById("dsResults").textContent = "";
  const header = document.getElementById("dsShowHeader");
  header.style.display = "flex";
  header.style.cssText +=
    ";align-items:center;gap:14px;";
  header.textContent = "";

  const img = document.createElement("img");
  img.style.cssText =
    "width:52px;height:74px;object-fit:cover;border-radius:8px;display:none;";
  header.appendChild(img);

  const meta = document.createElement("div");
  const title = document.createElement("div");
  title.style.cssText = "color:#fff;font-weight:600;";
  title.textContent = item.title;
  meta.appendChild(title);
  const state = document.createElement("div");
  state.className = "settings-hint";
  state.style.margin = "4px 0 0";
  state.textContent = dsT("dubsync.loading_seasons", "Loading episode list…");
  meta.appendChild(state);
  header.appendChild(meta);

  const change = document.createElement("button");
  change.textContent = dsT("dubsync.change_show", "Change");
  change.style.cssText =
    "margin-left:auto;padding:8px 16px;border-radius:10px;cursor:pointer;" +
    "border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);" +
    "color:#c8cad0;font-size:0.82rem;";
  change.onclick = () => {
    dsShow = null;
    dsSeasons = [];
    dsEpisodes = {};
    dsPairs = {};
    header.style.display = "none";
    document.getElementById("dsEpisodesSection").style.display = "none";
    dsUpdateSummary();
  };
  header.appendChild(change);

  try {
    const [seriesResp, seasonsResp] = await Promise.all([
      fetch("/api/series?url=" + encodeURIComponent(item.url)),
      fetch("/api/seasons?url=" + encodeURIComponent(item.url)),
    ]);
    const series = await seriesResp.json();
    const seasonsData = await seasonsResp.json();
    if (!seasonsResp.ok)
      throw new Error(seasonsData.error || seasonsResp.statusText);

    if (seriesResp.ok && series.poster_url) {
      img.src = series.poster_url;
      img.style.display = "block";
    }
    dsSeasons = (seasonsData.seasons || []).filter(
      (s) => s.season_number !== null && s.season_number !== undefined
    );

    const episodeResults = await Promise.all(
      dsSeasons.map((s) =>
        fetch("/api/episodes?url=" + encodeURIComponent(s.url))
          .then((r) => r.json())
          .catch(() => ({ episodes: [] }))
      )
    );
    dsSeasons.forEach((s, i) => {
      dsEpisodes[s.season_number] = episodeResults[i].episodes || [];
    });

    state.textContent =
      dsSeasons.length +
      " " +
      (dsSeasons.length === 1
        ? dsT("dubsync.season_one", "season")
        : dsT("dubsync.season_many", "seasons"));
    dsRenderEpisodes();
    dsApplyAutoSelection();
  } catch (e) {
    state.textContent =
      dsT("dubsync.load_failed", "Failed to load episodes: ") + e.message;
  }
}

// ===== Step 3: episode checklist =====

function dsRenderEpisodes() {
  const section = document.getElementById("dsEpisodesSection");
  const box = document.getElementById("dsSeasons");
  box.textContent = "";
  section.style.display = "block";

  for (const season of dsSeasons) {
    const sn = season.season_number;
    const episodes = dsEpisodes[sn] || [];
    const block = document.createElement("div");
    block.style.cssText = "margin-bottom: 16px";

    const head = document.createElement("label");
    head.style.cssText =
      "display:flex;align-items:center;gap:8px;color:#fff;font-weight:600;" +
      "font-size:0.92rem;cursor:pointer;margin-bottom:8px;";
    const all = document.createElement("input");
    all.type = "checkbox";
    all.style.cssText = "accent-color:#2563eb;cursor:pointer;";
    all.dataset.season = sn;
    all.onchange = () => {
      block
        .querySelectorAll("input[data-ep]")
        .forEach((cb) => (cb.checked = all.checked));
      dsUpdateSummary();
    };
    head.appendChild(all);
    head.appendChild(
      document.createTextNode(
        dsT("dubsync.season_label", "Season") + " " + sn
      )
    );
    block.appendChild(head);

    const grid = document.createElement("div");
    grid.style.cssText =
      "display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));" +
      "gap:4px 16px;";
    for (const ep of episodes) {
      const row = document.createElement("label");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;color:#c8cad0;" +
        "font-size:0.85rem;cursor:pointer;min-width:0;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.style.cssText = "accent-color:#2563eb;cursor:pointer;flex-shrink:0;";
      cb.dataset.ep = ep.episode_number;
      cb.dataset.season = sn;
      cb.onchange = dsUpdateSummary;
      row.appendChild(cb);

      const label = document.createElement("span");
      label.style.cssText =
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const epTitle = ep.title_de || ep.title_en || "";
      label.textContent =
        "E" + String(ep.episode_number).padStart(2, "0") +
        (epTitle ? " · " + epTitle : "");
      row.appendChild(label);

      const langs = ep.available_languages || [];
      if (langs.length && !langs.includes("German Dub")) {
        const warn = document.createElement("span");
        warn.title = dsT("dubsync.no_dub", "No German Dub available");
        warn.textContent = "⚠";
        warn.style.cssText = "color:#eab308;flex-shrink:0;";
        row.appendChild(warn);
      }

      const marker = document.createElement("span");
      marker.dataset.pairMarker = sn + ":" + ep.episode_number;
      marker.style.cssText =
        "display:none;color:#4ade80;font-size:0.75rem;flex-shrink:0;";
      marker.textContent = "●";
      row.appendChild(marker);

      grid.appendChild(row);
    }
    block.appendChild(grid);
    box.appendChild(block);
  }
}

// Mirror of the backend matcher's season resolution: filename season if
// present, else the source's single season, else 1 — plus the
// absolute-numbering fallback for globally-unique episode numbers.
function dsApplyAutoSelection() {
  const warnings = document.getElementById("dsMatchWarnings");
  warnings.textContent = "";
  dsPairs = {};

  document
    .querySelectorAll("#dsSeasons [data-pair-marker]")
    .forEach((m) => (m.style.display = "none"));

  if (!dsSeasons.length) {
    dsUpdateSummary();
    return;
  }

  const byKey = new Set();
  const absCount = {};
  for (const season of dsSeasons) {
    for (const ep of dsEpisodes[season.season_number] || []) {
      byKey.add(season.season_number + ":" + ep.episode_number);
      absCount[ep.episode_number] = (absCount[ep.episode_number] || []).concat(
        season.season_number
      );
    }
  }
  const singleSeason =
    dsSeasons.length === 1 ? dsSeasons[0].season_number : null;

  document
    .querySelectorAll("#dsSeasons input[data-ep]")
    .forEach((cb) => (cb.checked = false));

  const unpaired = [];
  for (const f of (dsScan && dsScan.files) || []) {
    let season = f.season !== null ? f.season : singleSeason !== null ? singleSeason : 1;
    let key = season + ":" + f.episode;
    if (!byKey.has(key) && f.season === null) {
      const seasonsWithEp = absCount[f.episode] || [];
      if (seasonsWithEp.length === 1) {
        key = seasonsWithEp[0] + ":" + f.episode;
      }
    }
    if (byKey.has(key) && !(key in dsPairs)) {
      dsPairs[key] = f.name;
    } else if (!byKey.has(key)) {
      unpaired.push(f);
    }
  }

  for (const key of Object.keys(dsPairs)) {
    const [s, e] = key.split(":");
    const cb = document.querySelector(
      '#dsSeasons input[data-season="' + s + '"][data-ep="' + e + '"]'
    );
    if (cb) cb.checked = true;
    const marker = document.querySelector(
      '#dsSeasons [data-pair-marker="' + key + '"]'
    );
    if (marker) {
      marker.style.display = "inline";
      marker.title =
        dsT("dubsync.local_file", "Local file: ") + dsPairs[key];
    }
  }

  const notes = [];
  if (unpaired.length) {
    notes.push(
      unpaired.length +
        " " +
        dsT("dubsync.unpaired", "local file(s) have no matching episode: ") +
        unpaired
          .slice(0, 5)
          .map((f) => f.name)
          .join(", ") +
        (unpaired.length > 5 ? ", …" : "")
    );
  }
  if (dsScan && dsScan.unparsed.length) {
    notes.push(
      dsT("dubsync.unparsed_note", "Not recognised: ") +
        dsScan.unparsed.slice(0, 5).join(", ") +
        (dsScan.unparsed.length > 5 ? ", …" : "")
    );
  }
  for (const note of notes) {
    const div = document.createElement("div");
    div.className = "settings-hint";
    div.style.cssText = "color:#eab308;margin-top:4px;";
    div.textContent = "⚠ " + note;
    warnings.appendChild(div);
  }

  dsUpdateSummary();
}

function dsSelectedEpisodes() {
  const selected = [];
  document.querySelectorAll("#dsSeasons input[data-ep]").forEach((cb) => {
    if (cb.checked)
      selected.push([parseInt(cb.dataset.season, 10), parseInt(cb.dataset.ep, 10)]);
  });
  return selected;
}

function dsUpdateSummary() {
  const n = dsSelectedEpisodes().length;
  const folder = document.getElementById("dsFolder").value.trim();
  const summary = document.getElementById("dsSummary");
  const btn = document.getElementById("dsEnqueueBtn");

  if (!dsShow || !folder) {
    summary.textContent = t(
      "dubsync.summary_incomplete",
      "Pick a folder and a show first"
    );
    btn.disabled = true;
    return;
  }
  summary.textContent =
    n +
    " " +
    (n === 1
      ? dsT("dubsync.summary_one", "episode selected")
      : dsT("dubsync.summary_many", "episodes selected"));
  btn.disabled = n === 0;
}

// ===== Enqueue =====

async function dsEnqueue() {
  const folder = document.getElementById("dsFolder").value.trim();
  const episodes = dsSelectedEpisodes();
  if (!dsShow || !folder || !episodes.length) return;

  const btn = document.getElementById("dsEnqueueBtn");
  btn.disabled = true;
  try {
    const resp = await fetch("/api/dubsync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: dsShow.url,
        target_dir: folder,
        offset: document.getElementById("dsOffset").value.trim(),
        auto_align: document.getElementById("dsAutoAlign").checked,
        allow_resample: document.getElementById("dsAllowResample").checked,
        cleanup: document.getElementById("dsCleanup").checked,
        recursive: document.getElementById("dsRecursive").checked,
        episodes: episodes,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.statusText);
    showToast(dsT("dubsync.queued", "DubSync job added to queue"));
  } catch (e) {
    showToast(dsT("dubsync.queue_failed", "Failed to enqueue: ") + e.message);
  } finally {
    btn.disabled = false;
    dsUpdateSummary();
  }
}

document.addEventListener("DOMContentLoaded", dsInit);
