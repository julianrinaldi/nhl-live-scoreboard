const CARD_TAG = "nhl-live-game-card";
const CARD_VERSION = "1.0.0"; // x-release-please-version
const EDITOR_TAG = "nhl-live-game-card-editor";
const INTEGRATION_DOMAIN = "nhl_live_scoreboard";
const DOCS_URL = "https://github.com/julianrinaldi/nhl-live-scoreboard";
const NAV_IDLE_RETURN_MS = 60000;
const PERIOD_IDLE_RETURN_MS = 20000;
console.info("[" + CARD_TAG + "] " + CARD_VERSION + " loaded");
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG, name: "NHL Live Game Card",
    description: "NHL Live Scoreboard (" + CARD_VERSION + ")",
    preview: true, documentationURL: DOCS_URL,
  });
}
const CARD_DEFAULTS = {
  title: "", show_matchup: true, show_records: true, show_linescore: false,
  show_plays: true, show_play_results: true, show_period_summary: true,
  show_strength: true, show_rink: true, show_situation: true,
  show_win_probability: true, show_shot_chart: false, show_highlights: false,
  refresh_rate: 0, player_link_target: "popup", show_team_stats_popup: true,
  team_stats_default_view: "auto", show_schedule_nav: true, show_period_nav: true,
  live_default_view: "collapsed", headshot_size: "auto",
};
const HEADSHOT_SIZE_PRESETS = { small: 40, medium: 56, large: 72, xlarge: 88 };
function findNhlEntity(hass) {
  const states = hass && hass.states || {};
  const ids = Object.keys(states);
  return ids.find((id) => id.startsWith("sensor.nhl_live_scoreboard")) ||
    ids.find((id) => {
      const a = states[id].attributes || {};
      return id.startsWith("sensor.") && a.league === "NHL" && a.team_abbr !== undefined &&
        a.display_event_id !== undefined && a.period_context !== undefined;
    }) || "";
}
const selectSchema = (name, options) => ({
  name, selector: { select: { mode: "dropdown", options } },
});
const EDITOR_SCHEMA = [
  { name: "entity", required: true,
    selector: { entity: { integration: INTEGRATION_DOMAIN, domain: "sensor" } } },
  { name: "title", selector: { text: {} } },
  { type: "grid", schema: [
    { name: "refresh_rate", selector: { number: {
      min: 0, max: 300, step: 1, mode: "box", unit_of_measurement: "s",
    } } },
    selectSchema("player_link_target", [
      { value: "popup", label: "In-card career popup" },
      { value: "espn", label: "ESPN player page" },
    ]),
    selectSchema("team_stats_default_view", [
      { value: "auto", label: "Auto (Game while live, else Season)" },
      { value: "game", label: "Game" }, { value: "season", label: "Season" },
    ]),
    selectSchema("live_default_view", [
      { value: "collapsed", label: "Collapsed (score line only)" },
      { value: "expanded", label: "Expanded (full live card)" },
    ]),
    selectSchema("headshot_size", [
      { value: "auto", label: "Auto (scale to card width)" },
      { value: "small", label: "Small (40px)" },
      { value: "medium", label: "Medium (56px)" },
      { value: "large", label: "Large (72px)" },
      { value: "xlarge", label: "X-Large (88px)" },
    ]),
    ...["show_team_stats_popup", "show_schedule_nav", "show_period_nav"].map(
      (name) => ({ name, selector: { boolean: {} } })),
  ] },
  { type: "grid", schema: [
    "show_matchup", "show_records", "show_linescore", "show_plays",
    "show_play_results", "show_period_summary", "show_strength", "show_rink",
    "show_shot_chart", "show_situation", "show_win_probability", "show_highlights",
  ].map((name) => ({ name, selector: { boolean: {} } })) },
];
const EDITOR_LABELS = {
  entity: "NHL Live Scoreboard entity", title: "Card title (optional)",
  refresh_rate: "Refresh rate (s, 0 = HA updates)", player_link_target: "Player name click",
  team_stats_default_view: "Team stats popup default view",
  live_default_view: "Live game default view", headshot_size: "Headshot size",
  show_team_stats_popup: "Enable team statistics popup",
  show_schedule_nav: "Schedule navigation arrows", show_period_nav: "Past period pager",
  show_matchup: "Goalie matchup", show_records: "Team records",
  show_linescore: "Period goals and shots on goal", show_plays: "Period play-by-play",
  show_play_results: "Play result indicators", show_period_summary: "Period summary",
  show_strength: "Strength, power plays and empty nets", show_rink: "Hockey rink",
  show_shot_chart: "Shot chart", show_situation: "Shots on goal",
  show_win_probability: "Win probability", show_highlights: "Highlights link (final)",
};
const EDITOR_HELPERS = {
  entity: "Pick the sensor created by the NHL Live Scoreboard integration.",
  refresh_rate: "0 leaves refreshing to Home Assistant state updates. This only repaints the card; it does not change ESPN polling.",
  live_default_view: "Collapsed shows the two score rows and period/clock. Click that header or its chevron to expand. Resets for each new game.",
  headshot_size: "Auto scales with the card width. Presets pin a fixed pixel size.",
  show_schedule_nav: "Adds previous/next game arrows to non-live cards. Returns to the automatic game after 60 seconds idle.",
  show_period_nav: "Pages through earlier periods and their scores. Returns to the current period after 20 seconds idle.",
  show_shot_chart: "Plots shots only when ESPN supplies rink coordinates. Missing locations are not invented.",
  show_highlights: "Shows an ESPN highlights link in the final-game panel only when ESPN has published one.",
};

class NhlLiveGameCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      const wrap = document.createElement("div");
      wrap.style.padding = "8px 0";
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.computeHelper = (s) => EDITOR_HELPERS[s.name] || "";
      this._form.schema = EDITOR_SCHEMA;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: ev.detail.value },
            bubbles: true,
            composed: true,
          }),
        );
      });
      wrap.appendChild(this._form);
      this.appendChild(wrap);
    }
    if (this._hass) this._form.hass = this._hass;
    // Seed with defaults so unset toggles show their true state; keep `type`
    // (and any other passthrough keys) so the emitted config stays valid.
    this._form.data = { ...CARD_DEFAULTS, ...(this._config || {}) };
  }
}

if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, NhlLiveGameCardEditor);
}


// Image cache shared across all card instances on the page.
//
// Each entry is { src, status }, where:
//   - src:    the URL to use as <img> src — initially the remote URL,
//             upgraded to a blob: URL once the image has been fetched once.
//   - status: "pending" while a fetch is in flight, "ready" once the blob
//             URL is stored, "failed" if the fetch failed (we keep using
//             the remote URL in that case so the image still loads).
//
// Why blob URLs? When the card re-renders we replace innerHTML, which
// destroys and re-creates every <img>. Even when the URL string is
// identical, ESPN's responses often arrive with cache-control headers
// that force the browser to revalidate (= a fresh network request per
// render). A blob: URL is a local in-memory reference — the browser
// never makes another network request for it.
window.__nhlLiveLogoCache = window.__nhlLiveLogoCache || new Map();

function _scheduleRerender(card) {
  // Cards that triggered a fetch should re-render once the blob URL is
  // ready, so the new <img> uses the cached source. We rAF-coalesce so
  // many concurrent fetch resolutions only fire one render.
  if (!card || typeof card.render !== "function") return;
  if (card._cacheRerenderPending) return;
  card._cacheRerenderPending = true;
  requestAnimationFrame(() => {
    card._cacheRerenderPending = false;
    // Clear the fingerprint so render() doesn't short-circuit.
    card._lastFingerprint = "";
    card.render();
  });
}

function _prefetchImage(card, normalized) {
  const cache = window.__nhlLiveLogoCache;
  const entry = cache.get(normalized);
  if (entry && entry.status !== "pending") return entry.src;
  if (entry && entry.status === "pending") return entry.src;

  // Mark as pending immediately so concurrent requests don't double-fetch.
  cache.set(normalized, { src: normalized, status: "pending" });

  // mode: "no-cors" works for cross-origin image hosts that don't send
  // CORS headers — the resulting opaque blob still works as an <img> src.
  // cache: "force-cache" lets the browser reuse its HTTP cache aggressively.
  fetch(normalized, {
    mode: "no-cors",
    cache: "force-cache",
    referrerPolicy: "no-referrer",
    credentials: "omit",
  })
    .then((resp) => resp.blob())
    .then((blob) => {
      if (!blob || !blob.size) {
        cache.set(normalized, { src: normalized, status: "failed" });
        return;
      }
      const objUrl = URL.createObjectURL(blob);
      cache.set(normalized, { src: objUrl, status: "ready" });
      _scheduleRerender(card);
    })
    .catch(() => {
      // Fetch failed (network, CORS opaque-with-error, etc.). Fall back to
      // the remote URL — the <img> tag still works, we just don't get the
      // blob-URL benefit for this asset.
      cache.set(normalized, { src: normalized, status: "failed" });
    });

  return normalized;
}

function requestCachedLogo(card, url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/^http:/i, "https:");
  const cache = window.__nhlLiveLogoCache;
  const entry = cache.get(normalized);
  if (entry) return entry.src || normalized;
  return _prefetchImage(card, normalized);
}

function get(obj, path, fallback = undefined) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return fallback;
    cur = cur[key];
  }
  return cur ?? fallback;
}

function parseScore(scoreObj) {
  if (scoreObj && typeof scoreObj === "object") {
    const text =
      scoreObj.displayValue ??
      (scoreObj.value != null ? String(scoreObj.value) : "");
    const num = scoreObj.value != null ? Number(scoreObj.value) : null;
    return { text, num: Number.isFinite(num) ? num : null };
  }
  if (scoreObj == null || scoreObj === "") return { text: "", num: null };
  const num = Number(scoreObj);
  return { text: String(scoreObj), num: Number.isFinite(num) ? num : null };
}

function competitorRecord(competitor, teamPayload) {
  if (competitor?.recordSummary) return String(competitor.recordSummary);
  const records = competitor?.records;
  if (Array.isArray(records) && records.length) {
    const overall =
      records.find((r) => String(r?.type || "").toLowerCase() === "total") ||
      records[0];
    if (overall?.summary) return String(overall.summary);
  }
  if (teamPayload?.record_summary) return String(teamPayload.record_summary);
  return "";
}


function formatEventDate(dateRaw) {
  if (!dateRaw) return "";
  const dt = new Date(dateRaw);
  if (Number.isNaN(dt.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfTarget = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const dayDiff = Math.round((startOfTarget - startOfToday) / 86400000);
  const timeText = dt.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (dayDiff === 0) return `Today ${timeText}`;
  if (dayDiff === 1) return `Tomorrow ${timeText}`;
  if (dayDiff === -1) return `Yesterday ${timeText}`;
  const dateText = dt.toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
  });
  return `${dateText} ${timeText}`;
}

function deriveGameState(attrs) {
  const competition = attrs.competition || {};
  const status = competition?.status || {};
  const type = status?.type || {};
  const mode = String(attrs.mode || "previous").toLowerCase();
  const state = String(type?.state || "").toLowerCase();
  const name = String(type?.name || "").toUpperCase();
  const detail = String(
    type?.detail ||
      type?.shortDetail ||
      type?.statusPrimary ||
      type?.description ||
      attrs.status_text ||
      "",
  ).trim();
  const eventDate = get(competition, ["date"], "");
  const scheduledText = formatEventDate(eventDate);
  // ESPN uses several status flavors for an interrupted live game
  // (STATUS_DELAYED, STATUS_RAIN_DELAY, STATUS_SUSPENDED, ...) and several
  // detail strings ("Delayed", "Rain Delay", "Weather Delay", "Delay: Rain").
  // Match on the shorter "delay" stem and on "suspend" so we flip the live
  // matchup panel off whenever the game is paused, not only when ESPN sends
  // the exact "Delayed" wording.
  const detailLower = detail.toLowerCase();
  const isDelayed =
    attrs.is_delayed === true ||
    name === "STATUS_DELAYED" ||
    name.includes("DELAY") ||
    name.includes("SUSPEND") ||
    detailLower.includes("delay") ||
    detailLower.includes("suspend");
  const isLive =
    attrs.is_live === true ||
    state === "in" ||
    state === "live" ||
    name === "STATUS_IN_PROGRESS" ||
    isDelayed;
  // Postponed/canceled games carry state="post" with completed=false. They
  // must be detected before isFinal — otherwise the "Final" pill + "F" marker
  // render over a misleading 0-0 score.
  const isPostponed =
    name === "STATUS_POSTPONED" ||
    name === "STATUS_CANCELED" ||
    (state === "post" && type?.completed === false) ||
    detail.toLowerCase().startsWith("postponed") ||
    detail.toLowerCase().startsWith("canceled");
  const isFinal =
    !isPostponed &&
    (state === "post" ||
      type?.completed === true ||
      name === "STATUS_FINAL" ||
      detail.toLowerCase().startsWith("final"));
  const isPregame =
    state === "pre" || name === "STATUS_SCHEDULED" || mode === "next";

  if (isDelayed) {
    return {
      pillText: "Delayed",
      pillClass: "delayed",
      statusText: detail || scheduledText || "Game delayed",
    };
  }

  if (isLive) {
    return {
      pillText: "Live",
      pillClass: "live",
      statusText: detail || "In progress",
    };
  }

  if (isPostponed) {
    return {
      pillText: "Postponed",
      pillClass: "postponed",
      statusText: detail || "Postponed",
    };
  }

  if (isFinal) {
    return {
      pillText: "Final",
      pillClass: "final",
      statusText: detail || "Final",
    };
  }

  if (isPregame) {
    return {
      pillText: "Next",
      pillClass: "next",
      statusText: detail || scheduledText || "Scheduled",
    };
  }

  return {
    pillText: mode === "previous" ? "Prev" : mode === "next" ? "Next" : "Game",
    pillClass: "idle",
    statusText: detail || scheduledText || "No game data",
  };
}


function shortPersonName(name) {
  const value = String(name || "").trim();
  if (!value) return "";
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return value;
  // Detect a generational suffix at the end (Jr., Sr., II, III, IV, V, etc.)
  // and keep it attached to the last name so we don't lose it when abbreviating
  // the first name (e.g. "Vladimir Guerrero Jr." -> "V. Guerrero Jr.").
  const SUFFIX_RE = /^(?:[JS]r\.?|I{1,3}|IV|VI{0,3})$/i;
  let suffix = "";
  if (parts.length >= 3 && SUFFIX_RE.test(parts[parts.length - 1])) {
    suffix = ` ${parts.pop()}`;
  }
  return `${parts[0].charAt(0)}. ${parts[parts.length - 1]}${suffix}`;
}

// Wrap an already display-formatted player name in a clickable link to that
// player's ESPN profile. Falls back to plain text when no athlete id is
// available (ESPN occasionally omits it) so the name is never lost. Click /
// keyboard activation is handled by the delegated listeners on .card-content.
function playerNameMarkup(name, athleteId) {
  const text = escapeHtml(name == null ? "" : name);
  const id = String(athleteId || "").trim();
  if (!id || !text) return text;
  return `<span class="player-link" role="link" tabindex="0" data-athlete-id="${escapeHtml(id)}" title="View ${text} on ESPN">${text}</span>`;
}

function renderPlayerHeadshot(card, url, alt = "") {
  const src = requestCachedLogo(card, url);
  return src
    ? `<img class="player-shot" src="${src}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<div class="player-shot placeholder"></div>`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ESPN's human-facing player page. Used both for the `player_link_target:
// espn` direct-open mode (Option A behavior) and the popup footer link, so
// the URL shape lives in one place.
function espnPlayerUrl(id) {
  return `https://www.espn.com/nhl/player/_/id/${encodeURIComponent(String(id == null ? "" : id))}`;
}


function playerCardBodyHtml(card, headshotSrc) {
  const safe = card && typeof card === "object" ? card : {};
  const bio = safe.bio || {};
  const career = safe.career || {};
  const glossary = safe.glossary || {};

  const shot = headshotSrc
    ? `<img class="nhl-pc-shot" src="${escapeHtml(headshotSrc)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<div class="nhl-pc-shot nhl-pc-shot--ph" aria-hidden="true"></div>`;

  const chips = [
    bio.team,
    bio.position,
    bio.college || "",
    bio.experience ? `${bio.experience} experience` : "",
    bio.height,
    bio.weight,
    bio.age ? `Age ${bio.age}` : "",
    bio.jersey ? `#${bio.jersey}` : "",
  ].filter((x) => x && String(x).trim());
  const sub = [
    bio.draft ? `Draft: ${bio.draft}` : "",
    bio.debut_year ? `NHL debut ${bio.debut_year}` : "",
  ].filter((x) => x && String(x).trim());

  const header =
    `<div class="nhl-pc-bio">${shot}<div class="nhl-pc-bio-meta">` +
    (chips.length
      ? `<div class="nhl-pc-bio-line">${chips.map((c) => escapeHtml(c)).join(" · ")}</div>`
      : "") +
    (sub.length
      ? `<div class="nhl-pc-bio-sub">${sub.map((c) => escapeHtml(c)).join(" · ")}</div>`
      : "") +
    `</div></div>`;

  const columns = Array.isArray(career.columns) ? career.columns : [];
  const seasons = Array.isArray(career.seasons) ? career.seasons : [];
  const totals = Array.isArray(career.totals) ? career.totals : [];

  let table;
  if (columns.length && seasons.length) {
    const headCells = columns
      .map((label) => {
        const tip = glossary[label];
        return `<th scope="col"${tip ? ` title="${escapeHtml(tip)}"` : ""}>${escapeHtml(label)}</th>`;
      })
      .join("");
    const bodyRows = seasons
      .map((s) => {
        const cells = columns
          .map((_, i) => `<td>${escapeHtml((s.stats || [])[i] ?? "")}</td>`)
          .join("");
        return (
          `<tr><th scope="row">${escapeHtml(s.year || "")}</th>` +
          `<td class="nhl-pc-team">${escapeHtml(s.team || "")}</td>${cells}</tr>`
        );
      })
      .join("");
    const totalRow = totals.length
      ? `<tr class="nhl-pc-total"><th scope="row">Career</th><td class="nhl-pc-team"></td>` +
        columns
          .map((_, i) => `<td>${escapeHtml(totals[i] ?? "")}</td>`)
          .join("") +
        `</tr>`
      : "";
    const kind = String(career.label || career.kind || "Hockey").replace(/_/g, " ");
    // tabindex+role so keyboard-only users can scroll the wide table while
    // focus is trapped in the dialog (WCAG 2.1.1); :focus-visible styled.
    table =
      `<div class="nhl-pc-table-wrap" tabindex="0" role="group" ` +
      `aria-label="${escapeHtml(kind)} career stats, scrollable"><table class="nhl-pc-table">` +
      `<caption class="nhl-pc-caption">${escapeHtml(kind)} — career by season</caption>` +
      `<thead><tr><th scope="col">Year</th><th scope="col">Team</th>${headCells}</tr></thead>` +
      `<tbody>${bodyRows}${totalRow}</tbody></table></div>`;
  } else {
    table = `<div class="nhl-pc-msg nhl-pc-nostats">No career stats available for this player.</div>`;
  }

  return header + table;
}



function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function deepActiveElement() {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}
function periodLabel(period, context = {}) {
  if (context.is_shootout) return "SO";
  const n = Number(period) || 0;
  return n > 3 ? (n === 4 ? "OT" : (n - 3) + "OT") : n > 0 ? "P" + n : "";
}
function periodContext(attrs) {
  const ctx = attrs.period_context || {};
  const status = attrs.competition && attrs.competition.status || {};
  const period = Number(ctx.period || status.period || 0);
  const type = status.type || {};
  const shootout = Object.prototype.hasOwnProperty.call(ctx, "is_shootout")
    ? ctx.is_shootout === true : /shootout|(?:^|[ /_])SO(?:$|[ /_])/i.test(
      [type.name, type.detail, type.shortDetail].filter(Boolean).join(" "));
  return {
    ...ctx, period, is_shootout: shootout,
    // An explicit blank means the normalized snapshot has no countdown.
    // Earlier periods must not inherit the current competition's live clock.
    display_clock: Object.prototype.hasOwnProperty.call(ctx, "display_clock")
      ? ctx.display_clock ?? "" : status.displayClock ?? type.displayClock ?? "",
    display_period: ctx.display_period || periodLabel(period, {is_shootout: shootout}),
  };
}
function renderDots(count, total, klass) {
  const value = numberOrNull(count);
  if (value === null) return '<span class="subtle">—</span>';
  return Array.from({ length: total }, (_, i) =>
    '<span class="dot ' + klass + (i < Math.max(0, Math.min(total, value)) ? ' on' : '') + '"></span>').join("");
}
function renderSituationRow(situation, awayLabel = "Away", homeLabel = "Home") {
  const s = situation || {};
  const away = numberOrNull(s.away_shots_on_goal);
  const home = numberOrNull(s.home_shots_on_goal);
  return '<div class="count-dots-row prominent verbose nhl-situation">' +
    '<span class="count-pack"><span class="dots-label verbose">' + escapeHtml(awayLabel) + ' SOG:</span><span>' + escapeHtml(away ?? "—") + '</span></span>' +
    '<span class="count-pack"><span class="dots-label verbose">' + escapeHtml(homeLabel) + ' SOG:</span><span>' + escapeHtml(home ?? "—") + '</span></span></div>';
}
function powerPlaySide(attrs) {
  const id = String(attrs.situation && attrs.situation.power_play_team_id || "");
  for (const side of ["away", "home"]) {
    const meta = attrs[side + "_team"] || {};
    const comp = (attrs.competition && attrs.competition.competitors || []).find((c) => c.homeAway === side);
    if (id && (id === String(meta.id || "") || id === String(comp && comp.team && comp.team.id || ""))) return side;
  }
  return "";
}
function teamAbbreviation(attrs, side) {
  const meta = attrs[side + "_team"] || {};
  const comp = (attrs.competition && attrs.competition.competitors || []).find((c) => c.homeAway === side);
  return meta.abbreviation || comp && comp.team && comp.team.abbreviation || side.toUpperCase();
}
function renderStrengthRow(attrs) {
  const s = attrs.situation || {};
  const ppSide = powerPlaySide(attrs);
  const strength = String(s.strength || "");
  // The feed can identify a power play or an empty net without identifying
  // the team. Keep that global information without assigning it to a side.
  const globalIndicators = [
    s.power_play === true && !ppSide && !/power\s*play/i.test(strength) ? "Power play" : "",
    s.empty_net === true && s.away_empty_net !== true && s.home_empty_net !== true && !/empty\s*net/i.test(strength) ? "Empty net" : "",
  ].filter(Boolean);
  const side = (name) => '<div class="base-slot"><span class="base-label">' + escapeHtml(teamAbbreviation(attrs, name)) + '</span>' +
    (ppSide === name ? '<span class="nhl-power-play" title="Power play">PP</span>' : "") +
    (s[name + "_empty_net"] === true ? '<span class="nhl-empty-net" title="Empty net">EN</span>' : "") + '</div>';
  return '<div class="bases-occupancy-row nhl-strength">' + side("away") +
    '<div class="nhl-strength-label">' + escapeHtml([strength, ...globalIndicators].filter(Boolean).join(" · ") || "Strength —") + '</div>' + side("home") + '</div>';
}
function renderWinProbabilityRow(winProb, ownerSide, ownerLabel, opponentLabel) {
  if (!winProb || typeof winProb !== "object") return "";
  const owner = numberOrNull(winProb[ownerSide === "home" ? "home" : "away"]);
  const opponent = numberOrNull(winProb[ownerSide === "home" ? "away" : "home"]);
  if (owner === null || opponent === null || owner + opponent <= 0) return "";
  const fill = Math.max(0, Math.min(100, owner / (owner + opponent) * 100));
  return '<div class="win-prob-row" title="Win probability"><div class="win-prob-bar">' +
    '<div class="win-prob-fill" style="width:' + fill.toFixed(1) + '%"></div>' +
    '<span class="win-prob-label win-prob-label-owner">' + escapeHtml(ownerLabel) + ' ' + Math.round(owner) + '%</span>' +
    '<span class="win-prob-label win-prob-label-opponent">' + Math.round(opponent) + '% ' + escapeHtml(opponentLabel) + '</span></div></div>';
}
function renderRink(attrs, plays, detailed) {
  // This compact rink is a diagram, not a claim about the puck's live position.
  const circles = [33.76, 166.24].flatMap((x) => [26.38, 68.62].map((y) =>
    '<circle cx="' + x + '" cy="' + y + '" r="14.4" class="nhl-rink-circle"/>' +
    '<circle cx="' + x + '" cy="' + y + '" r="1.2" class="nhl-rink-red"/>')).join("");
  const homeId = String(attrs.home_team && attrs.home_team.id || "");
  const awayId = String(attrs.away_team && attrs.away_team.id || "");
  const shots = detailed ? (Array.isArray(plays) ? plays : []).flatMap((play) => {
    if (!play || !play.is_shot || play.is_shootout) return [];
    const point = play.coordinate || {};
    if (typeof point.x !== "number" || typeof point.y !== "number") return [];
    const x = numberOrNull(point.x), y = numberOrNull(point.y);
    // ESPN's verified coordinates are centered rink feet. Never clamp an
    // invalid location into a plausible-looking shot on the ice.
    if (x === null || y === null || Math.abs(x) > 100 || Math.abs(y) > 42.5) return [];
    return [{play, x: 100 + x * .96, y: 47.5 - y * .96}];
  }) : [];
  const shotSide = (play) => {
    const id = String(play.team_id || "");
    return homeId && id === homeId ? "home" : awayId && id === awayId ? "away" : "unknown";
  };
  const points = shots.map(({play, x, y}) => '<g><title>' + escapeHtml(play.text || play.shot_type || "Shot") + '</title>' +
    '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="' + (play.scoring_play ? "3" : "2") + '" class="nhl-rink-play ' +
    shotSide(play) + (play.scoring_play ? ' goal' : '') + '"/></g>').join("");
  const caption = shots.length ? shots.length + " shot locations · ESPN rink coordinates" : "Shot locations unavailable";
  const aria = detailed ? "Selected-period shot chart. " + caption : "Hockey rink diagram";
  return '<div class="' + (detailed ? "nhl-shot-chart" : "matchup-center nhl-rink-center") + '" role="img" aria-label="' + escapeHtml(aria) + '">' +
    '<svg viewBox="0 0 200 95" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' +
    '<rect x="4" y="6.7" width="192" height="81.6" rx="26.88" class="nhl-rink-outline"/>' +
    '<path d="M76 6.7V88.3M124 6.7V88.3" class="nhl-rink-blue"/>' +
    '<path d="M100 6.7V88.3M14.56 18V77M185.44 18V77" class="nhl-rink-red"/>' +
    '<circle cx="100" cy="47.5" r="14.4" class="nhl-rink-circle"/>' +
    '<circle cx="100" cy="47.5" r="1.5" class="nhl-rink-red"/>' + circles +
    '<path d="M14.56 41.74A5.76 5.76 0 0 1 14.56 53.26ZM185.44 41.74A5.76 5.76 0 0 0 185.44 53.26Z" class="nhl-rink-crease"/>' +
    '<path d="M14.56 44.62H11.68V50.38H14.56M185.44 44.62H188.32V50.38H185.44" class="nhl-rink-red"/>' + points +
    '</svg>' + (detailed ? '<div class="nhl-chart-caption">' + escapeHtml(caption) +
      (shots.length ? ' · <span class="nhl-shot-away">' + escapeHtml(teamAbbreviation(attrs,"away")) + '</span> / <span class="nhl-shot-home">' + escapeHtml(teamAbbreviation(attrs,"home")) + '</span>' : '') +
      (shots.some(({play}) => shotSide(play) === "unknown") ? ' / Team unknown' : '') + '</div>' : "") + '</div>';
}
function goalieLines(goalie, pregame) {
  const q = goalie || {};
  const game = q.game_stats || {};
  const hasGame = Object.values(game).some((v) => v !== "" && v !== null && v !== undefined);
  const s = pregame || !hasGame ? q.season_stats || {} : game;
  const stat = (value, label) => value !== null && value !== undefined && value !== "" ? value + " " + label : "";
  const record = [s.wins, s.losses, s.overtime_losses].every((v) => v !== null && v !== undefined && v !== "") ?
    [s.wins, s.losses, s.overtime_losses].join("-") : "";
  const seasonView = pregame || !hasGame;
  const primary = seasonView && record ? record : [stat(s.saves, "SV"), stat(s.shots_against, "SA")].filter(Boolean).join(" • ");
  const secondary = [
    stat(seasonView ? s.goals_against_average : s.goals_against, seasonView ? "GAA" : "GA"),
    stat(s.save_percentage, "SV%"),
  ].filter(Boolean).join(" • ");
  const context = seasonView && s.season ? s.season + " season" : pregame && (q.id || q.display_name) ? "Goalie" : "";
  return {primary, secondary, context};
}
function teamPopupAttrs(card, attrs, side) {
  if (card.config.show_team_stats_popup === false) return "";
  const team = attrs.team_stats && attrs.team_stats[side] || attrs[side + "_team"] || {};
  const name = team.name || team.abbreviation || side + " team";
  return ' data-team-popup="' + side + '" role="button" tabindex="0" aria-label="Show ' +
    escapeHtml(name) + ' team statistics" title="Show ' + escapeHtml(name) + ' team statistics"';
}
function renderGoalieSide(card, attrs, side, pregame) {
  const q = attrs.goalies && attrs.goalies[side] || {};
  const meta = attrs[side + "_team"] || {};
  const name = q.short_name || q.display_name || "";
  const lines = goalieLines(q, pregame);
  const src = q.headshot || meta.logo || "";
  const portrait = pregame
    ? (src ? '<img class="upcoming-goalie-img' + (!q.headshot ? ' logo-fallback' : '') + '" src="' + escapeHtml(requestCachedLogo(card, src)) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '<div class="upcoming-goalie-img placeholder"></div>')
    : renderPlayerHeadshot(card, src, name || teamAbbreviation(attrs, side));
  return '<div class="matchup-side with-headshot stacked centered-half' + (pregame ? ' upcoming-goalie-side' : '') + '"' +
    teamPopupAttrs(card, attrs, side) + '>' + portrait +
    '<div class="matchup-copy centered-copy"><div class="' + (pregame ? "upcoming-goalie-name" : "matchup-value") + '">' +
    playerNameMarkup(name ? shortPersonName(name) : "TBD", q.id) + '</div>' +
    '<div class="matchup-subtle strongish stat-line">' + escapeHtml(lines.primary || "—") + '</div>' +
    '<div class="matchup-subtle secondary stat-line">' + escapeHtml(lines.secondary) + '</div>' +
    (lines.context ? '<div class="nhl-goalie-context">' + escapeHtml(lines.context) + '</div>' : "") +
    '</div></div>';
}
function renderGoalieMatchup(card, attrs, pregame) {
  const center = pregame ? '<div class="upcoming-goalies-vs">vs</div>' :
    card.config.show_rink !== false ? renderRink(attrs, [], false) : "";
  return '<div class="' + (pregame ? "upcoming-goalies-grid" : "matchup-block") + '">' +
    (pregame ? "" : '<div class="matchup-grid enhanced productionish nhl-matchup' + (!center ? ' nhl-no-rink' : '') + '">') +
    renderGoalieSide(card, attrs, "away", pregame) + center + renderGoalieSide(card, attrs, "home", pregame) +
    (pregame ? "" : '</div>') + '</div>';
}
function renderIntermissionLeaders(card, attrs, ownerSide) {
  const list = (attrs.leaders && attrs.leaders[ownerSide] || []).filter(Boolean).slice(0, 3);
  if (!list.length) return "";
  const ctx = periodContext(attrs);
  const label = ctx.is_intermission ? "Intermission" : ctx.label || "End of " + periodLabel(ctx.period, ctx);
  return '<div class="break-leaders-panel"><div class="break-leaders-title">' + escapeHtml(label) + '&nbsp;&nbsp;Game Leaders</div><div class="break-leaders-grid">' +
    list.map((p) => '<div class="break-leaders-card">' + renderPlayerHeadshot(card, p.headshot || "", p.name || "") +
      '<div class="break-leaders-name">' + playerNameMarkup(shortPersonName(p.name || "—"), p.id) + '</div>' +
      '<div class="nhl-leader-category">' + escapeHtml(p.category || "") + '</div>' +
      '<div class="break-leaders-stat">' + escapeHtml(p.value || "—") + '</div></div>').join("") + '</div></div>';
}
function renderPeriodSummary(period) {
  const d = period || {};
  const parts = [
    d.label || periodLabel(d.number, d),
    d.play_count !== null && d.play_count !== undefined && d.play_count !== "" ? d.play_count + " plays" : "",
    !d.is_shootout && d.goals !== null && d.goals !== undefined && d.goals !== "" ? d.goals + (Number(d.goals) === 1 ? " goal" : " goals") : "",
  ].filter(Boolean);
  const label = parts.join(" • ") || d.description || "";
  return label ? '<div class="on-deck-row nhl-period-summary"><span class="on-deck-label">Period:</span><span>' + escapeHtml(label) + '</span></div>' : "";
}
function playIndicator(play) {
  if (play.is_shootout) return play.scoring_play ? "SO goal" : play.abbreviation || "SO";
  if (play.scoring_play || Number(play.score_value) > 0) {
    const away = numberOrNull(play.away_score), home = numberOrNull(play.home_score);
    return away !== null && home !== null ? away + "-" + home : "GOAL";
  }
  if (play.is_penalty) return "PEN";
  if (play.is_shot) return play.abbreviation || "SHOT";
  return play.abbreviation || "";
}
function renderRecentPlays(plays, config) {
  if (config.show_plays === false) return "";
  const list = (Array.isArray(plays) ? plays : []).filter((p) => p && p.text).reverse();
  if (!list.length) return '<div class="plays-panel"><div class="subtle">Waiting for play-by-play.</div></div>';
  return '<div class="plays-panel" tabindex="0" role="region" aria-label="Period play-by-play, newest first">' +
    '<div class="nhl-play-order">Newest first</div>' + list.map((p) => {
    const clock = [periodLabel(p.period_number || p.period, p), !p.is_shootout && (p.clock || p.display_clock)].filter(Boolean).join(" ");
    return '<div class="play-row"><div class="play-text">' +
      (clock ? '<span class="nhl-play-clock">' + escapeHtml(clock) + '</span> ' : "") +
      escapeHtml(p.text) + '</div><div class="play-indicator">' +
      (config.show_play_results !== false ? escapeHtml(playIndicator(p)) : "") + '</div></div>';
  }).join("") + '</div>';
}
function renderPeriodStrip(body, atLive, previousDisabled) {
  const button = (cls, triangle, label, disabled) => '<button class="period-nav-btn ' + cls + '" type="button" aria-label="' + label + '" title="' + label + '"' +
    (disabled ? " disabled" : "") + '><span class="tri ' + triangle + '"></span></button>';
  return body + '<div class="period-strip">' +
    (atLive ? "" : button("period-nav-next", "tri-up", "Later period", false)) +
    button("period-nav-prev", "tri-down", "Previous period", previousDisabled) + '</div>';
}
function renderScoringPlaysPanel(attrs, awayMeta, homeMeta) {
  const list = (Array.isArray(attrs.scoring_plays) ? attrs.scoring_plays : []).filter((p) => p && !p.is_shootout);
  if (!list.length) return "";
  let prevAway = 0, prevHome = 0;
  return '<div class="scoring-plays-panel"><div class="panel-heading">Scoring Plays</div>' + list.map((p) => {
    const a = numberOrNull(p.away_score), h = numberOrNull(p.home_score);
    const id = String(p.team_id || "");
    let abbr = id && id === String(awayMeta.id || "") ? awayMeta.abbreviation :
      id && id === String(homeMeta.id || "") ? homeMeta.abbreviation :
      a !== null && a > prevAway ? awayMeta.abbreviation : h !== null && h > prevHome ? homeMeta.abbreviation : "";
    if (a !== null) prevAway = a;
    if (h !== null) prevHome = h;
    const period = periodLabel(p.period_number || p.period, p);
    return '<div class="scoring-play-row"><span class="scoring-play-period">' + escapeHtml(period) + '</span>' +
      '<span class="scoring-play-team">' + escapeHtml(abbr || "") + '</span><span class="scoring-play-text">' +
      (p.clock ? '<span class="nhl-play-clock">' + escapeHtml(p.clock) + '</span> ' : "") + escapeHtml(p.text || "") +
      '</span><span class="scoring-play-score">' + escapeHtml(a !== null && h !== null ? a + "-" + h : "") + '</span></div>';
  }).join("") + '</div>';
}
function renderGameLeadersPanel(attrs, awayMeta, homeMeta) {
  const leaders = attrs.leaders || {};
  if (!(leaders.away || []).length && !(leaders.home || []).length) return "";
  const col = (side, meta) => '<div class="leaders-col"><div class="leaders-head">' + escapeHtml(meta.abbreviation || side.toUpperCase()) + '</div>' +
    (leaders[side] || []).map((p) => '<div class="leader-item"><span class="leader-cat">' + escapeHtml(p.category || "") +
      '</span><span class="leader-name">' + playerNameMarkup(shortPersonName(p.name || ""), p.id) +
      '</span><span class="leader-val">' + escapeHtml(p.value || "") + '</span></div>').join("") + '</div>';
  return '<div class="leaders-panel"><div class="panel-heading">Game Leaders</div><div class="leaders-grid">' + col("away", awayMeta) + col("home", homeMeta) + '</div></div>';
}
function renderUpcomingDetails(card, attrs, awayMeta, homeMeta, awayLogo, homeLogo, options) {
  const final = options && options.kind === "final";
  const standings = attrs.division_standings || {};
  const mostRecent = String(attrs.display_event_id || "") === String(attrs.previous_event_id || "");
  const showStandings = !final || mostRecent;
  const entries = Array.isArray(standings.entries) ? standings.entries : [];
  const standingsHtml = entries.length && showStandings ? '<div class="upcoming-standings">' +
    '<div class="standings-heading">' + escapeHtml(standings.division_name || "") + '</div>' +
    '<div class="standings-row standings-header"><span>Team</span><span class="standings-wl">W-L-OTL</span><span class="standings-gb">PTS</span></div>' +
    entries.map((e) => '<div class="standings-row' + (String(e.team_id || "") === String(attrs.team_id || "") ? ' my-team' : '') + '">' +
      '<span class="standings-name">' + escapeHtml(e.team_short_name || e.team_name || "—") + '</span>' +
      '<span class="standings-wl">' + escapeHtml([e.wins ?? "—", e.losses ?? "—", e.overtime_losses ?? "—"].join("-")) + '</span>' +
      '<span class="standings-gb">' + escapeHtml(e.points ?? "—") + '</span></div>').join("") + '</div>' : "";
  const highlights = final && card.config.show_highlights === true && /^https:\/\/([^/]+\.)?espn\.com\//i.test(String(attrs.highlights_url || ""))
    ? '<div class="final-highlights-row"><a class="final-highlights-link" href="' + escapeHtml(attrs.highlights_url) + '" target="_blank" rel="noopener noreferrer"><span class="final-highlights-icon" aria-hidden="true">▶</span><span class="final-highlights-label">Watch highlights on ESPN</span></a></div>' : "";
  return '<div class="upcoming-details-panel">' +
    (!final && card.config.show_matchup !== false ? renderGoalieMatchup(card, attrs, true) : "") +
    (final ? renderScoringPlaysPanel(attrs, awayMeta, homeMeta) + renderGameLeadersPanel(attrs, awayMeta, homeMeta) : "") +
    highlights + standingsHtml + '</div>';
}
function teamStatsTablesHtml(team, view, seasonStats) {
  const categories = team && Array.isArray(team.categories) ? team.categories : [];
  if (!categories.some((c) => (c.rows || []).length)) return '<div class="nhl-lu-msg">Team statistics are not available yet.</div>';
  const season = view === "season";
  return (team.source === "roster" && !season ? '<div class="nhl-lu-msg">Roster — game statistics are not available yet.</div>' : "") + categories.map((category) => {
    const rows = Array.isArray(category.rows) ? category.rows : [];
    if (!rows.length) return "";
    const sample = season ? rows.map((r) => seasonStats && seasonStats[String(r.id)] && seasonStats[String(r.id)].categories && seasonStats[String(r.id)].categories[category.name]).find(Boolean) : null;
    const columns = sample && sample.columns || category.columns || [];
    const keys = sample && sample.keys || category.keys || [];
    const descriptions = sample ? sample.descriptions || [] : category.descriptions || [];
    const rowSeason = (r) => seasonStats && seasonStats[String(r.id)] && seasonStats[String(r.id)].season || "";
    const years = season ? [...new Set(rows.map(rowSeason).filter(Boolean).map(String))] : [];
    const mixedSeasons = years.length > 1;
    const seasonLabel = years.length === 1 ? " · " + years[0] + " season" : mixedSeasons ? " · Latest available seasons" : "";
    const header = '<tr><th scope="col" class="nhl-lu-name">Player</th>' +
      (mixedSeasons ? '<th scope="col">Season</th>' : "") +
      columns.map((c, i) => '<th scope="col"' + (descriptions[i] ? ' title="' + escapeHtml(descriptions[i]) + '"' : "") + '>' + escapeHtml(c) + '</th>').join("") + '</tr>';
    const body = rows.map((r) => {
      const stats = season ? seasonStats && seasonStats[String(r.id)] && seasonStats[String(r.id)].categories && seasonStats[String(r.id)].categories[category.name] : null;
      const values = season ? stats && stats.stats || [] : r.stats || [];
      const sourceKeys = season ? stats && stats.keys || [] : category.keys || [];
      const cells = columns.map((_, i) => {
        const index = keys[i] && sourceKeys.length ? sourceKeys.indexOf(keys[i]) : i;
        const value = index >= 0 ? values[index] : null;
        return '<td>' + escapeHtml(value === null || value === undefined || value === "" ? "—" : value) + '</td>';
      }).join("");
      return '<tr><th scope="row" class="nhl-lu-name">' + escapeHtml(shortPersonName(r.name || r.short_name || "—")) + '</th>' +
        (mixedSeasons ? '<td>' + escapeHtml(rowSeason(r) || "—") + '</td>' : "") + cells + '</tr>';
    }).join("");
    const totals = !season && Array.isArray(category.totals) && category.totals.length ?
      '<tr class="nhl-lu-total"><th scope="row" class="nhl-lu-name">Team</th>' + columns.map((_, i) => '<td>' + escapeHtml(category.totals[i] ?? "—") + '</td>').join("") + '</tr>' : "";
    return '<div class="nhl-lu-table-wrap" tabindex="0" role="group" aria-label="' + escapeHtml(category.label || category.name) +
      ', scrollable"><table class="nhl-lu-table"><caption class="nhl-lu-caption">' + escapeHtml(category.label || category.name) +
      ' (' + rows.length + ')' + escapeHtml(seasonLabel) + '</caption><thead>' + header + '</thead><tbody>' + body + totals + '</tbody></table></div>';
  }).join("");
}

class NhlLiveGameCard extends HTMLElement {


  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }


  static getStubConfig(hass) {
    return { entity: findNhlEntity(hass) };
  }

  setConfig(config) {



    this.config = { ...CARD_DEFAULTS, ...(config || {}) };
    this._lastFingerprint = this._lastCompactFp = this._lastCompactHtml = this._lastLiveHtml = "";

    this._clearRefreshTimer();

    this._resetScheduleNav();

    this._resetPeriodNav();


    this._liveExpanded = this._liveDefaultExpanded();
    this._liveExpandedGameKey = undefined;

    this._navAnchorId = undefined;
    this._periodAnchorKey = undefined;
  }



  _liveDefaultExpanded() {
    return (
      String(this.config?.live_default_view || "collapsed").toLowerCase() ===
      "expanded"
    );
  }



  _resetScheduleNav() {
    this._navGeneration = (this._navGeneration || 0) + 1;
    this._navOffset = 0;
    this._navGameData = null;



    this._navHasPrev = true;
    this._navHasNext = true;
    this._navInflight = null;
    if (this._navCache instanceof Map) this._navCache.clear();
    else this._navCache = new Map();
    this._clearNavIdleTimer();
  }



  _resetPeriodNav() {
    this._periodGeneration = (this._periodGeneration || 0) + 1;
    this._periodOffset = 0;
    this._periodView = null;
    this._periodHasPrev = true;
    this._periodHasNext = true;
    this._periodInflight = null;
    if (this._periodCache instanceof Map) this._periodCache.clear();
    else this._periodCache = new Map();
    this._clearPeriodIdleTimer();
  }

  _clearRefreshTimer() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
  }




  _headshotSizeClass() {
    const v = String(this.config?.headshot_size || "auto").toLowerCase();
    if (v === "auto" || HEADSHOT_SIZE_PRESETS[v] != null) {
      return `headshot-size-${v}`;
    }
    return "headshot-size-auto";
  }

  _upcomingDetailsFingerprint(attrs) {
    return JSON.stringify([attrs.goalies, attrs.division_standings,
      attrs.scoring_plays, attrs.leaders, attrs.highlights_url, attrs.team_stats]);
  }

  _openPlayerProfile(el) {
    const link = el instanceof Element ? el.closest(".player-link") : null;
    if (!link || !this.content.contains(link)) return false;
    const id = link.getAttribute("data-athlete-id");
    if (id) {




      const target = String(
        this.config?.player_link_target || "popup",
      ).toLowerCase();
      if (target === "espn") {
        window.open(espnPlayerUrl(id), "_blank", "noopener");
      } else {
        this._openPlayerCardPopup(id, link);
      }
    }
    return true;
  }





  _toggleLineupFromMatchup(el) {
    const side = el instanceof Element ? el.closest(".matchup-side") : null;
    if (!side || !this.content.contains(side)) return false;
    const popupSide = side.getAttribute("data-team-popup");
    if (popupSide !== "away" && popupSide !== "home") return false;
    if (this._isLineupPopupOpen(popupSide)) this._closeLineupPopup();
    else this._openLineupPopup(popupSide, side);
    return true;
  }





  _fetchPlayerCard(athleteId) {
    const id = String(athleteId == null ? "" : athleteId).trim();
    if (!id || !this._hass || !this._hass.connection)
      return Promise.resolve(null);
    this._playerCardCache = this._playerCardCache || new Map();
    this._playerCardInflight = this._playerCardInflight || new Map();
    if (this._playerCardCache.has(id))
      return Promise.resolve(this._playerCardCache.get(id));
    if (this._playerCardInflight.has(id))
      return this._playerCardInflight.get(id);
    const req = this._hass.connection
      .sendMessagePromise({
        type: "nhl_live_scoreboard/player_card",
        athlete_id: id,
      })
      .then((res) => {
        const card = (res && res.player_card) || null;
        if (card) this._playerCardCache.set(id, card);
        return card;
      })
      .catch((err) => {
        console.debug(`[${CARD_TAG}] player_card fetch failed for ${id}:`, err);
        return null;
      })
      .finally(() => {
        this._playerCardInflight.delete(id);
      });
    this._playerCardInflight.set(id, req);
    return req;
  }




  _ensurePlayerCardPopup() {
    if (this._pcOverlay) return;
    if (!document.getElementById("nhl-pc-style")) {
      const style = document.createElement("style");
      style.id = "nhl-pc-style";
      style.textContent = `
        .nhl-pc-overlay {
          position: fixed; inset: 0; z-index: 99999;
          display: flex; align-items: center; justify-content: center;
          padding: 16px; background: rgba(0,0,0,0.6);
        }
        .nhl-pc-overlay[hidden] { display: none; }
        .nhl-pc-dialog {
          width: min(560px, 94vw); max-height: 86vh;
          display: flex; flex-direction: column; overflow: hidden;
          background: var(--card-background-color, var(--ha-card-background, #1c1c1c));
          color: var(--primary-text-color, #e1e1e1);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          outline: none;
        }
        .nhl-pc-header {
          display: flex; align-items: center; gap: 8px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        }
        .nhl-pc-title {
          flex: 1; min-width: 0; font-weight: 600; font-size: 1.05em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: var(--warning-color, #ffb300);
        }
        .nhl-pc-close {
          flex: none; cursor: pointer; border: 0; border-radius: 50%;
          width: 30px; height: 30px; line-height: 30px; padding: 0;
          font-size: 16px; background: transparent;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .nhl-pc-close:hover { color: var(--primary-text-color, #fff); }
        .nhl-pc-close:focus-visible,
        .nhl-pc-espn:focus-visible,
        .nhl-pc-table-wrap:focus-visible {
          outline: 2px solid var(--warning-color, #ffb300); outline-offset: 2px;
        }
        .nhl-pc-body {
          padding: 18px 16px; overflow: auto;
          min-height: 96px; display: flex;
          align-items: center; justify-content: center; text-align: center;
        }
        .nhl-pc-msg { color: var(--secondary-text-color, #9b9b9b); }
        .nhl-pc-retry {
          margin-top: 10px; cursor: pointer;
          background: transparent; color: var(--warning-color, #ffb300);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
          border-radius: 6px; padding: 5px 12px;
        }
        .nhl-pc-spinner {
          width: 26px; height: 26px; border-radius: 50%;
          border: 3px solid var(--divider-color, rgba(255,255,255,0.2));
          border-top-color: var(--warning-color, #ffb300);
          animation: nhl-pc-spin 0.8s linear infinite; margin: 0 auto 10px;
        }
        @keyframes nhl-pc-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .nhl-pc-spinner { animation-duration: 2s; }
        }
        .nhl-pc-footer {
          padding: 10px 14px; text-align: right;
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        }
        .nhl-pc-espn {
          color: var(--warning-color, #ffb300);
          text-decoration: none; font-size: 0.92em;
        }
        .nhl-pc-espn:hover { text-decoration: underline; }
        .nhl-pc-body--ready {
          display: block; text-align: left; align-items: stretch;
        }
        .nhl-pc-bio {
          display: flex; align-items: center; gap: 14px; margin-bottom: 14px;
        }
        .nhl-pc-shot {
          flex: none; width: 64px; height: 64px; border-radius: 50%;
          object-fit: cover;
          background: var(--divider-color, rgba(255,255,255,0.12));
        }
        .nhl-pc-shot--ph { display: block; }
        .nhl-pc-bio-meta { min-width: 0; }
        .nhl-pc-bio-line {
          font-size: 0.9em; color: var(--primary-text-color, #e1e1e1);
        }
        .nhl-pc-bio-sub {
          font-size: 0.82em; color: var(--secondary-text-color, #9b9b9b);
          margin-top: 4px;
        }
        .nhl-pc-table-wrap {
          overflow-x: auto; -webkit-overflow-scrolling: touch;
        }
        .nhl-pc-table {
          border-collapse: collapse; width: 100%;
          font-size: 0.82em; white-space: nowrap;
        }
        .nhl-pc-caption {
          caption-side: top; text-align: left; padding: 0 0 6px;
          font-size: 0.92em; color: var(--secondary-text-color, #9b9b9b);
        }
        .nhl-pc-table th, .nhl-pc-table td {
          padding: 5px 8px; text-align: right;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.08));
        }
        .nhl-pc-table thead th {
          color: var(--secondary-text-color, #9b9b9b);
          font-weight: 600; cursor: help;
        }
        .nhl-pc-table th[scope="row"] { text-align: left; }
        .nhl-pc-table td.nhl-pc-team { text-align: left; }
        .nhl-pc-total th, .nhl-pc-total td {
          font-weight: 700;
          color: var(--primary-text-color, #e1e1e1);
          border-top: 2px solid var(--divider-color, rgba(255,255,255,0.2));
          border-bottom: 0;
        }
      `;
      document.head.appendChild(style);
    }

    const overlay = document.createElement("div");
    overlay.className = "nhl-pc-overlay";
    overlay.hidden = true;


    const titleId = `nhl-pc-title-${Math.random().toString(36).slice(2, 9)}`;
    overlay.innerHTML = `
      <div class="nhl-pc-dialog" role="dialog" aria-modal="true"
           aria-labelledby="${titleId}" tabindex="-1">
        <div class="nhl-pc-header">
          <div class="nhl-pc-title" id="${titleId}" role="heading" aria-level="2">Player</div>
          <button class="nhl-pc-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="nhl-pc-body" aria-live="polite"></div>
        <div class="nhl-pc-footer">
          <a class="nhl-pc-espn" target="_blank" rel="noopener noreferrer">View on ESPN ↗</a>
        </div>
      </div>`;

    this._pcOverlay = overlay;
    this._pcDialog = overlay.querySelector(".nhl-pc-dialog");
    this._pcTitle = overlay.querySelector(".nhl-pc-title");
    this._pcBody = overlay.querySelector(".nhl-pc-body");
    this._pcEspn = overlay.querySelector(".nhl-pc-espn");

    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) return this._closePlayerCardPopup();
      const t = ev.target instanceof Element ? ev.target : null;
      if (t && t.closest(".nhl-pc-close")) return this._closePlayerCardPopup();
      if (t && t.closest(".nhl-pc-retry") && this._pcAthleteId) {
        this._openPlayerCardPopup(this._pcAthleteId);
      }
    });
    overlay.addEventListener("keydown", (ev) => this._onPcKeydown(ev));
    document.body.appendChild(overlay);
  }

  _onPcKeydown(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this._closePlayerCardPopup();
      return;
    }
    if (ev.key !== "Tab") return;
    const focusables = this._pcDialog.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) {
      ev.preventDefault();
      this._pcDialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || active === this._pcDialog)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  _setPlayerCardState(state, card) {
    if (!this._pcBody) return;


    if (this._pcDialog) {
      this._pcDialog.setAttribute(
        "aria-busy",
        state === "loading" ? "true" : "false",
      );
    }


    this._pcBody.className =
      state === "ready" ? "nhl-pc-body nhl-pc-body--ready" : "nhl-pc-body";
    if (state === "loading") {
      this._pcBody.innerHTML = `<div><div class="nhl-pc-spinner"></div><div class="nhl-pc-msg">Loading player…</div></div>`;
    } else if (state === "error") {
      this._pcBody.innerHTML =
        `<div><div class="nhl-pc-msg">Couldn't load this player.</div>` +
        `<button class="nhl-pc-retry" type="button" data-pc-retry>Retry</button></div>`;
    } else if (state === "empty") {
      this._pcBody.innerHTML = `<div class="nhl-pc-msg">No stats available for this player.</div>`;
    } else {



      const safe = card || {};
      const shot = requestCachedLogo(
        this,
        (safe.bio && safe.bio.headshot) || "",
      );
      this._pcBody.innerHTML = playerCardBodyHtml(safe, shot);
    }
  }

  _openPlayerCardPopup(athleteId, trigger = null) {
    const id = String(athleteId == null ? "" : athleteId).trim();
    if (!id) return;
    this._ensurePlayerCardPopup();
    this._pcAthleteId = id;
    if (this._pcOverlay.hidden) {
      this._pcReturnFocus = trigger || deepActiveElement();
      this._pcFocusAthleteId = id;
      this._pcPrevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      this._pcOverlay.hidden = false;
    }
    this._pcTitle.textContent = "Player";
    this._pcEspn.href = espnPlayerUrl(id);
    this._setPlayerCardState("loading");
    this._pcDialog.focus();

    const token = (this._pcToken || 0) + 1;
    this._pcToken = token;
    this._fetchPlayerCard(id).then((card) => {

      if (token !== this._pcToken || this._pcOverlay.hidden) return;
      if (!card) {
        this._setPlayerCardState("error");
      } else if (!card.bio?.name && !(card.career?.seasons || []).length) {
        this._setPlayerCardState("empty");
      } else {
        if (card.bio?.name) this._pcTitle.textContent = card.bio.name;
        this._setPlayerCardState("ready", card);
      }
    });
  }

  _closePlayerCardPopup() {
    if (!this._pcOverlay || this._pcOverlay.hidden) return;
    this._pcToken = (this._pcToken || 0) + 1; // invalidate any in-flight render
    this._pcOverlay.hidden = true;
    document.body.style.overflow = this._pcPrevBodyOverflow || "";
    this._restoreCardFocus(this._pcReturnFocus, ".player-link", "data-athlete-id", this._pcFocusAthleteId);
    this._pcReturnFocus = null;
  }

  _destroyPlayerCardPopup() {
    if (!this._pcOverlay) return;
    this._closePlayerCardPopup();
    this._pcOverlay.remove();
    this._pcOverlay = null;
    this._pcDialog = this._pcTitle = this._pcBody = this._pcEspn = null;
  }












  _teamSeasonKey(team) {
    const ids = [...new Set((team && team.categories || []).flatMap((c) =>
      (c.rows || []).map((r) => String(r.id || "")).filter(Boolean)))].sort();
    return String(team && team.team_id || "") + ":" + ids.join(",");
  }

  _fetchTeamSeasonStats(side) {
    const team = this._lineupTeam(side === "home" ? "home" : "away");
    if (!team || !this._hass || !this._hass.connection) return Promise.resolve(null);
    const ids = [...new Set((team.categories || []).flatMap((c) =>
      (c.rows || []).map((r) => String(r.id || "")).filter(Boolean)))];
    const key = this._teamSeasonKey(team);
    this._luSeasonCache = this._luSeasonCache || new Map();
    this._luSeasonInflight = this._luSeasonInflight || new Map();
    if (this._luSeasonCache.has(key)) return Promise.resolve(this._luSeasonCache.get(key));
    if (this._luSeasonInflight.has(key)) return this._luSeasonInflight.get(key);
    if (!ids.length) return Promise.resolve({});
    const req = this._hass.connection.sendMessagePromise({
      type: "nhl_live_scoreboard/team_season_stats", athlete_ids: ids,
    }).then((res) => {
      const map = res && res.season_stats || {};
      this._luSeasonCache.set(key, map);
      return map;
    }).catch((err) => {
      console.debug("[" + CARD_TAG + "] season stats fetch failed:", err);
      return null;
    }).finally(() => this._luSeasonInflight.delete(key));
    this._luSeasonInflight.set(key, req);
    return req;
  }

  _lineupTeam(side) {
    const st = this._hass && this._hass.states[this.config.entity];
    const attrs = this._displayAttrs || st && st.attributes || {};
    return attrs.team_stats && attrs.team_stats[side] || null;
  }

  _ensureLineupPopup() {
    if (this._luOverlay) return;
    if (!document.getElementById("nhl-lu-style")) {
      const style = document.createElement("style");
      style.id = "nhl-lu-style";
      style.textContent = `
        .nhl-lu-overlay {
          position: fixed; inset: 0; z-index: 99999;
          display: flex; align-items: center; justify-content: center;
          padding: 16px; background: rgba(0,0,0,0.6);
        }
        .nhl-lu-overlay[hidden] { display: none; }
        .nhl-lu-dialog {
          width: min(640px, 95vw); max-height: 88vh;
          display: flex; flex-direction: column; overflow: hidden;
          background: var(--card-background-color, var(--ha-card-background, #1c1c1c));
          color: var(--primary-text-color, #e1e1e1);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          outline: none;
        }
        .nhl-lu-header {
          display: flex; align-items: center; gap: 10px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        }
        .nhl-lu-logo {
          flex: none; width: 30px; height: 30px; object-fit: contain;
        }
        .nhl-lu-title {
          flex: 1; min-width: 0; font-weight: 600; font-size: 1.05em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: var(--warning-color, #ffb300);
        }
        .nhl-lu-views {
          flex: none; display: flex; gap: 2px; padding: 2px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
          border-radius: 8px;
        }
        .nhl-lu-views label {
          cursor: pointer; font-size: 0.82em; line-height: 1;
          padding: 5px 10px; border-radius: 6px;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .nhl-lu-views input { position: absolute; opacity: 0; pointer-events: none; }
        .nhl-lu-views label:has(input:checked) {
          background: var(--warning-color, #ffb300);
          color: var(--text-primary-color, #111);
        }
        .nhl-lu-views label:has(input:focus-visible) {
          outline: 2px solid var(--warning-color, #ffb300); outline-offset: 2px;
        }
        .nhl-lu-close {
          flex: none; cursor: pointer; border: 0; border-radius: 50%;
          width: 30px; height: 30px; line-height: 30px; padding: 0;
          font-size: 16px; background: transparent;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .nhl-lu-close:hover { color: var(--primary-text-color, #fff); }
        .nhl-lu-close:focus-visible,
        .nhl-lu-table-wrap:focus-visible {
          outline: 2px solid var(--warning-color, #ffb300); outline-offset: 2px;
        }
        .nhl-lu-body {
          padding: 14px 16px; overflow: auto; min-height: 96px;
        }
        .nhl-lu-body--msg {
          display: flex; align-items: center; justify-content: center;
          text-align: center;
        }
        .nhl-lu-msg { color: var(--secondary-text-color, #9b9b9b); }
        .nhl-lu-retry {
          margin-top: 10px; cursor: pointer;
          background: transparent; color: var(--warning-color, #ffb300);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
          border-radius: 6px; padding: 5px 12px;
        }
        .nhl-lu-spinner {
          width: 26px; height: 26px; border-radius: 50%;
          border: 3px solid var(--divider-color, rgba(255,255,255,0.2));
          border-top-color: var(--warning-color, #ffb300);
          animation: nhl-lu-spin 0.8s linear infinite; margin: 0 auto 10px;
        }
        @keyframes nhl-lu-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .nhl-lu-spinner { animation-duration: 2s; }
        }
        .nhl-lu-table-wrap {
          overflow-x: auto; -webkit-overflow-scrolling: touch;
          margin-bottom: 14px;
        }
        .nhl-lu-table-wrap:last-child { margin-bottom: 0; }
        .nhl-lu-table {
          border-collapse: collapse; width: 100%;
          font-size: 0.82em; white-space: nowrap;
        }
        .nhl-lu-caption {
          caption-side: top; text-align: left; padding: 2px 0 6px;
          font-size: 0.92em; font-weight: 600;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .nhl-lu-table th, .nhl-lu-table td {
          padding: 5px 8px; text-align: right;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.08));
        }
        .nhl-lu-table thead th {
          color: var(--secondary-text-color, #9b9b9b); font-weight: 600;
        }
        .nhl-lu-table th.nhl-lu-name, .nhl-lu-table td.nhl-lu-name,
        .nhl-lu-table th.nhl-lu-pos, .nhl-lu-table td.nhl-lu-pos,
        .nhl-lu-table th.nhl-lu-num, .nhl-lu-table td.nhl-lu-num {
          text-align: left;
        }
        .nhl-lu-table td.nhl-lu-name { color: var(--primary-text-color, #e1e1e1); }

        .nhl-lu-up {
          display: inline-block;
          width: 0.8em;
          margin-right: 2px;
          color: var(--accent-color, #f5c518);
          font-size: 0.9em;
          line-height: 1;
        }
        /* Visually hidden, still announced. */
        .nhl-lu-sr {
          position: absolute;
          width: 1px; height: 1px;
          margin: -1px; padding: 0; border: 0;
          overflow: hidden;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          white-space: nowrap;
        }
        .nhl-lu-table .nhl-lu-num { width: 1.5em; }
        .nhl-lu-table tr.nhl-lu-out td, .nhl-lu-table tr.nhl-lu-out th {
          opacity: 0.55;
        }
      `;
      document.head.appendChild(style);
    }

    const overlay = document.createElement("div");
    overlay.className = "nhl-lu-overlay";
    overlay.hidden = true;


    const uid = Math.random().toString(36).slice(2, 9);
    const titleId = `nhl-lu-title-${uid}`;
    const grp = `nhl-lu-view-${uid}`;
    overlay.innerHTML = `
      <div class="nhl-lu-dialog" role="dialog" aria-modal="true"
           aria-labelledby="${titleId}" tabindex="-1">
        <div class="nhl-lu-header">
          <img class="nhl-lu-logo" alt="" aria-hidden="true" hidden
               loading="lazy" decoding="async" referrerpolicy="no-referrer">
          <div class="nhl-lu-title" id="${titleId}" role="heading" aria-level="2">Team stats</div>
          <div class="nhl-lu-views" role="radiogroup" aria-label="Stats view">
            <label><input type="radio" name="${grp}" class="nhl-lu-view" value="game" checked>Game</label>
            <label><input type="radio" name="${grp}" class="nhl-lu-view" value="season">Season</label>
          </div>
          <button class="nhl-lu-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="nhl-lu-body" aria-live="polite"></div>
      </div>`;

    this._luOverlay = overlay;
    this._luDialog = overlay.querySelector(".nhl-lu-dialog");
    this._luTitle = overlay.querySelector(".nhl-lu-title");
    this._luLogo = overlay.querySelector(".nhl-lu-logo");
    this._luBody = overlay.querySelector(".nhl-lu-body");

    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) return this._closeLineupPopup();
      const t = ev.target instanceof Element ? ev.target : null;
      if (t && t.closest(".nhl-lu-close")) return this._closeLineupPopup();
      if (t && t.closest(".nhl-lu-retry")) return this._renderLineupBody();
    });
    overlay.addEventListener("change", (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (t && t.classList.contains("nhl-lu-view")) {
        this._setLineupView(t.value === "season" ? "season" : "game");
      }
    });
    overlay.addEventListener("keydown", (ev) => this._onLuKeydown(ev));
    document.body.appendChild(overlay);
  }

  _onLuKeydown(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this._closeLineupPopup();
      return;
    }
    if (ev.key !== "Tab") return;

    const focusables = this._luDialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) {
      ev.preventDefault();
      this._luDialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || active === this._luDialog)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  _setLineupState(state) {
    if (!this._luBody) return;
    if (this._luDialog) {
      this._luDialog.setAttribute(
        "aria-busy",
        state === "loading" ? "true" : "false",
      );
    }
    this._luBody.className =
      state === "ready" ? "nhl-lu-body" : "nhl-lu-body nhl-lu-body--msg";
    if (state === "loading") {
      this._luBody.innerHTML = `<div><div class="nhl-lu-spinner"></div><div class="nhl-lu-msg">Loading season stats…</div></div>`;
    } else if (state === "error") {
      this._luBody.innerHTML =
        `<div><div class="nhl-lu-msg">Couldn't load season stats.</div>` +
        `<button class="nhl-lu-retry" type="button">Retry</button></div>`;
    } else if (state === "pregame") {
      this._luBody.innerHTML = `<div class="nhl-lu-msg">Team statistics are not available yet.</div>`;
    }
  }



  _renderLineupBody() {
    if (!this._luBody) return;
    const side = this._luSide;
    const team = this._lineupTeam(side);
    const name = (team && (team.name || team.abbreviation)) || "Team stats";
    if (this._luTitle) this._luTitle.textContent = name;
    if (this._luLogo) {
      const src = team ? requestCachedLogo(this, team.logo || "") : "";
      if (src) {
        this._luLogo.src = src;
        this._luLogo.hidden = false;
      } else {
        this._luLogo.hidden = true;
      }
    }
    const hasPlayers = team && (team.categories || []).some((c) => (c.rows || []).length);
    if (!hasPlayers) {
      this._setLineupState("pregame");
      return;
    }
    if (this._luView === "season") {
      this._renderLineupSeason(side, team);
      return;
    }
    this._setLineupState("ready");
    this._setTeamBodyHtml(teamStatsTablesHtml(team, "game", {}));
  }






  _renderLineupSeason(side, team) {
    const teamKey = this._teamSeasonKey(team);
    const cached =
      this._luSeasonCache instanceof Map
        ? this._luSeasonCache.get(teamKey)
        : undefined;
    if (cached !== undefined) {
      this._luSeasonStats = cached;
      this._setLineupState("ready");
      this._setTeamBodyHtml(teamStatsTablesHtml(team, "season", cached));
      return;
    }
    this._setLineupState("loading");
    this._fetchTeamSeasonStats(side).then((map) => {
      if (!this._isLineupPopupOpen(side) || this._luView !== "season") return;
      if (map == null) {
        this._setLineupState("error");
        return;
      }
      this._luSeasonStats = map;
      this._setLineupState("ready");
      this._setTeamBodyHtml(teamStatsTablesHtml(
        this._lineupTeam(side) || team,
        "season",
        map,
      ));
    });
  }

  _setTeamBodyHtml(html) {
    if (!this._luBody || this._luBody.innerHTML === html) return;
    const oldTables = [...this._luBody.querySelectorAll(".nhl-lu-table-wrap")];
    const positions = oldTables.map((table) => ({left: table.scrollLeft, top: table.scrollTop}));
    const focused = oldTables.indexOf(document.activeElement);
    this._luBody.innerHTML = html;
    const tables = [...this._luBody.querySelectorAll(".nhl-lu-table-wrap")];
    tables.forEach((table, index) => {
      if (positions[index]) {
        table.scrollLeft = positions[index].left;
        table.scrollTop = positions[index].top;
      }
    });
    if (focused >= 0 && tables[focused]) tables[focused].focus({preventScroll: true});
  }

  _setLineupView(view) {
    const v = view === "season" ? "season" : "game";
    if (this._luView === v) return;
    this._luView = v;
    this._renderLineupBody();
  }

  _openLineupPopup(side, trigger = null) {
    const s = side === "home" ? "home" : "away";
    this._ensureLineupPopup();
    this._luSide = s;


    const pref = String(
      this.config.team_stats_default_view || "auto",
    ).toLowerCase();
    if (pref === "game" || pref === "season") {
      this._luView = pref;
    } else {
      const ent = this.config && this.config.entity;
      const st = ent && this._hass ? this._hass.states[ent] : null;
      const live = !!((this._displayAttrs || st && st.attributes || {}).is_live);
      this._luView = live ? "game" : "season";
    }
    const radios = this._luOverlay.querySelectorAll(".nhl-lu-view");
    radios.forEach((r) => {
      r.checked = r.value === this._luView;
    });
    if (this._luOverlay.hidden) {
      this._luReturnFocus = trigger || deepActiveElement();
      this._luFocusSide = s;
      this._luPrevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      this._luOverlay.hidden = false;
    }
    this._renderLineupBody();
    this._luDialog.focus();
  }

  _closeLineupPopup() {
    if (!this._luOverlay || this._luOverlay.hidden) return;
    this._luOverlay.hidden = true;
    document.body.style.overflow = this._luPrevBodyOverflow || "";
    this._restoreCardFocus(this._luReturnFocus, ".matchup-side", "data-team-popup", this._luFocusSide);
    this._luReturnFocus = null;
  }

  _isLineupPopupOpen(side) {
    return !!(
      this._luOverlay &&
      !this._luOverlay.hidden &&
      (side == null || this._luSide === (side === "home" ? "home" : "away"))
    );
  }

  _destroyLineupPopup() {
    if (!this._luOverlay) return;
    this._closeLineupPopup();
    this._luOverlay.remove();
    this._luOverlay = null;
    this._luDialog = this._luTitle = this._luLogo = this._luBody = null;
  }

  _onContentClick(ev) {
    // Native links inside the compact expander retain their own activation.
    if (ev.target instanceof Element && ev.target.closest("a[href]")) return;


    const navBtn =
      ev.target instanceof Element
        ? ev.target.closest(".schedule-nav-btn")
        : null;
    if (navBtn && this.content.contains(navBtn)) {
      ev.preventDefault();
      ev.stopPropagation();
      if (navBtn.disabled || navBtn.getAttribute("aria-disabled") === "true")
        return;
      this._navigateSchedule(
        navBtn.classList.contains("schedule-nav-next") ? 1 : -1,
      );
      return;
    }
    const periodBtn =
      ev.target instanceof Element
        ? ev.target.closest(".period-nav-btn")
        : null;
    if (periodBtn && this.content.contains(periodBtn)) {
      ev.preventDefault();
      ev.stopPropagation();
      if (
        periodBtn.disabled ||
        periodBtn.getAttribute("aria-disabled") === "true"
      )
        return;
      this._navigatePeriod(
        periodBtn.classList.contains("period-nav-next") ? 1 : -1,
      );
      return;
    }



    const liveHeader =
      ev.target instanceof Element
        ? ev.target.closest(".live-expandable")
        : null;
    if (liveHeader && this.content.contains(liveHeader)) {
      ev.preventDefault();
      this._toggleLiveExpand();
      return;
    }
    if (this._openPlayerProfile(ev.target)) return;
    if (this._toggleLineupFromMatchup(ev.target)) return;
    const target =
      ev.target instanceof Element
        ? ev.target.closest(".upcoming-expandable")
        : null;
    if (!target || !this.content.contains(target)) return;
    this._upcomingExpanded = !this._upcomingExpanded;

    this._lastFingerprint = "";
    this._lastCompactFp = "";
    this.render();
  }



  _toggleLiveExpand() {
    this._liveExpanded = this._liveExpanded !== true;




    if (!this._liveExpanded) this._resetPeriodNav();


    this._lastFingerprint = "";
    this._lastLiveHtml = "";
    this.render();
  }

  _onContentKeydown(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    if (ev.target instanceof Element && ev.target.closest("a[href], button, input, select, textarea")) return;


    if (
      ev.target instanceof Element &&
      ev.target.closest(".schedule-nav-btn, .period-nav-btn")
    )
      return;
    const playerLink =
      ev.target instanceof Element ? ev.target.closest(".player-link") : null;
    if (playerLink && this.content.contains(playerLink)) {
      ev.preventDefault();
      this._openPlayerProfile(playerLink);
      return;
    }
    const luSide =
      ev.target instanceof Element ? ev.target.closest(".matchup-side") : null;
    if (
      luSide &&
      this.content.contains(luSide) &&
      ["away", "home"].includes(luSide.getAttribute("data-team-popup"))
    ) {
      ev.preventDefault();
      this._toggleLineupFromMatchup(luSide);
      return;
    }
    const liveHeader =
      ev.target instanceof Element
        ? ev.target.closest(".live-expandable")
        : null;
    if (liveHeader && this.content.contains(liveHeader)) {
      ev.preventDefault();
      this._toggleLiveExpand();
      return;
    }
    const target =
      ev.target instanceof Element
        ? ev.target.closest(".upcoming-expandable")
        : null;
    if (!target || !this.content.contains(target)) return;
    ev.preventDefault();
    this._upcomingExpanded = !this._upcomingExpanded;
    this._lastFingerprint = "";
    this._lastCompactFp = "";
    this.render();
  }



  _navigateSchedule(delta) {
    const target = this._navOffset + delta;
    if (target === 0) {


      this._navOffset = 0;
      this._navGameData = null;
      this._navHasPrev = true;
      this._navHasNext = true;
      this._forceScheduleRerender();
      return;
    }
    if (this._navCache instanceof Map && this._navCache.has(target)) {
      this._applyNavResult(this._navCache.get(target));
      return;
    }
    if (this._navInflight) return; // de-dupe rapid taps
    const entity = this.config?.entity;
    const conn = this._hass?.connection;
    if (!entity || !conn) return;
    const generation = this._navGeneration;
    this._navInflight = conn
      .sendMessagePromise({
        type: "nhl_live_scoreboard/game_at_offset",
        entity_id: entity,
        offset: target,
      })
      .then((res) => {
        if (generation !== this._navGeneration) return;
        if (!res || !res.game_data) {


          if (delta < 0) this._navHasPrev = false;
          else this._navHasNext = false;
          this._forceScheduleRerender();
          return;
        }
        if (this._navCache instanceof Map) this._navCache.set(res.offset, res);
        this._applyNavResult(res);
      })
      .catch((err) => {
        console.debug(`[${CARD_TAG}] game_at_offset fetch failed:`, err);
      })
      .finally(() => {
        if (generation === this._navGeneration) this._navInflight = null;
      });
  }

  _applyNavResult(res) {
    this._navOffset = res.offset;


    this._navGameData = res.offset === 0 ? null : res.game_data;
    this._navHasPrev = res.has_prev !== false;
    this._navHasNext = res.has_next !== false;
    this._forceScheduleRerender();
  }


  _forceScheduleRerender() {
    this._lastFingerprint = "";
    this._lastCompactFp = "";
    this._lastLiveHtml = "";

    if (this._navOffset !== 0) this._armNavIdleTimer();
    else this._clearNavIdleTimer();
    this.render();
  }

  _armNavIdleTimer() {
    this._clearNavIdleTimer();
    this._navIdleTimer = setTimeout(() => {
      this._navIdleTimer = null;
      if (this._navOffset !== 0) {
        this._resetScheduleNav();
        this._forceScheduleRerender();
      }
    }, NAV_IDLE_RETURN_MS);
  }

  _clearNavIdleTimer() {
    if (this._navIdleTimer) {
      clearTimeout(this._navIdleTimer);
      this._navIdleTimer = null;
    }
  }




  _navigatePeriod(delta) {
    const target = Math.min(0, this._periodOffset + delta);
    if (target === this._periodOffset) return; // already at the current period
    if (target === 0) {
      this._periodOffset = 0;
      this._periodView = null;
      this._periodHasPrev = true;
      this._forcePeriodRerender();
      return;
    }
    if (this._periodCache instanceof Map && this._periodCache.has(target)) {
      this._applyPeriodResult(this._periodCache.get(target));
      return;
    }
    if (this._periodInflight) return; // de-dupe rapid taps
    const entity = this.config?.entity;
    const conn = this._hass?.connection;
    if (!entity || !conn) return;
    const generation = this._periodGeneration;
    this._periodInflight = conn
      .sendMessagePromise({
        type: "nhl_live_scoreboard/period_at_offset",
        entity_id: entity,
        offset: target,
      })
      .then((res) => {
        if (generation !== this._periodGeneration) return;
        if (!res || !Array.isArray(res.recent_plays)) {


          if (delta < 0) this._periodHasPrev = false;
          this._forcePeriodRerender();
          return;
        }
        if (this._periodCache instanceof Map)
          this._periodCache.set(res.offset, res);
        this._applyPeriodResult(res);
      })
      .catch((err) => {
        console.debug(`[${CARD_TAG}] period_at_offset fetch failed:`, err);
      })
      .finally(() => {
        if (generation === this._periodGeneration) this._periodInflight = null;
      });
  }

  _applyPeriodResult(res) {
    this._periodOffset = res.offset;


    this._periodView = res.offset === 0 ? null : res;
    this._periodHasPrev = res.has_prev !== false;
    this._periodHasNext = res.has_next !== false;
    this._forcePeriodRerender();
  }

  _forcePeriodRerender() {
    this._lastFingerprint = "";
    this._lastCompactFp = "";
    this._lastLiveHtml = "";

    if (this._periodOffset !== 0) this._armPeriodIdleTimer();
    else this._clearPeriodIdleTimer();
    this.render();
  }

  _armPeriodIdleTimer() {
    this._clearPeriodIdleTimer();
    this._periodIdleTimer = setTimeout(() => {
      this._periodIdleTimer = null;
      if (this._periodOffset !== 0) {
        this._resetPeriodNav();
        this._forcePeriodRerender();
      }
    }, PERIOD_IDLE_RETURN_MS);
  }

  _clearPeriodIdleTimer() {
    if (this._periodIdleTimer) {
      clearTimeout(this._periodIdleTimer);
      this._periodIdleTimer = null;
    }
  }

  _setupRefreshTimer() {
    this._clearRefreshTimer();
    const rate = Number(this.config.refresh_rate);
    if (rate > 0 && this._hass) {
      this._refreshInterval = setInterval(() => {
        if (this._hass && this.config?.entity) {




          this._lastFingerprint = "";
          this._lastCompactFp = "";
          this.render();
        }
      }, rate * 1000);
    }
  }

  disconnectedCallback() {
    this._clearRefreshTimer();
    // Invalidate pending navigation and leave reconnect on the current game.
    // Merely clearing idle timers would strand an old game/period indefinitely.
    this._resetScheduleNav();
    this._resetPeriodNav();
    this._lastFingerprint = this._lastCompactFp = this._lastLiveHtml = "";
    this._destroyPlayerCardPopup();
    this._destroyLineupPopup();
  }

  _restoreCardFocus(previous, selector, attribute, value) {
    // isConnected works through Home Assistant's shadow roots; document.contains
    // does not. If a live repaint replaced the opener, restore its logical twin.
    if (previous && previous.isConnected) {
      previous.focus();
      return;
    }
    if (!this.isConnected || !this.content) return;
    const candidates = [...this.content.querySelectorAll(selector)];
    const replacement = candidates.find((element) => element.getAttribute(attribute) === String(value || ""));
    const target = replacement || this.content.querySelector(".live-expandable, .upcoming-expandable");
    if (target) target.focus();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.card) {
      ensureCardStyles(this);
      this.card = document.createElement("ha-card");
      this.card.className = "nhl-live-game-card";
      this.content = document.createElement("div");
      this.content.className = "card-content";
      this.card.appendChild(this.content);
      this.appendChild(this.card);
      this.content.addEventListener("click", (ev) => this._onContentClick(ev));
      this.content.addEventListener("keydown", (ev) =>
        this._onContentKeydown(ev),
      );
    }
    this.render();




    if (!this._refreshInterval) {
      this._setupRefreshTimer();
    }
  }

  getCardSize() {
    return 4;
  }



  renderLinescore(competition, history, attrs = {}) {
    const competitors = competition.competitors || [];
    const away = competitors.find((c) => c.homeAway === "away") || {};
    const home = competitors.find((c) => c.homeAway === "home") || {};
    const a = away.linescores || [], h = home.linescores || [];
    if (!a.length && !h.length) return "";
    const context = history && history.period_context || periodContext(attrs);
    const historyPeriod = history && Number(context.period || 0);
    const periods = Math.max(3, Math.min(20, historyPeriod || Math.max(a.length, h.length)));
    const scoreFor = (side, competitor, lines, index) => {
      if (!historyPeriod) return (lines[index] && (lines[index].displayValue ?? lines[index].value)) ?? "";
      if (index + 1 > historyPeriod) return "";
      if (index + 1 < historyPeriod) return (lines[index] && (lines[index].displayValue ?? lines[index].value)) ?? "";
      const total = numberOrNull(history[side + "_score"]);
      const prior = lines.slice(0, index).map((p) => numberOrNull(p.displayValue ?? p.value));
      if (total === null || prior.length < index || prior.some((p) => p === null)) return "—";
      const previous = prior.reduce((sum, value) => sum + value, 0);
      return Math.max(0, total - previous);
    };
    const header = Array.from({length: periods}, (_, i) => '<div class="period-head">' +
      periodLabel(i + 1, {is_shootout: !!context.is_shootout && i + 1 === Number(context.period)}) + '</div>').join("");
    const shots = attrs.situation || {};
    const row = (side, comp, lines) => '<div class="team-abbr">' + escapeHtml(comp.team && comp.team.abbreviation || side.toUpperCase()) + '</div>' +
      Array.from({length: periods}, (_, i) => '<div class="period-cell">' + escapeHtml(scoreFor(side, comp, lines, i)) + '</div>').join("") +
      '<div class="period-total">' + escapeHtml(history ? history[side + "_score"] ?? "—" : parseScore(comp.score).text || "—") + '</div>' +
      '<div class="period-total">' + escapeHtml(numberOrNull(shots[side + "_shots_on_goal"]) ?? "—") + '</div>';
    return '<div class="linescore"><div class="linescore-grid" style="grid-template-columns:max-content repeat(' + periods + ',minmax(18px,1fr)) repeat(2,max-content)">' +
      '<div></div>' + header + '<div class="period-head">G</div><div class="period-head">SOG</div>' + row("away", away, a) + row("home", home, h) + '</div></div>';
  }

  _computeRenderFingerprint(stateObj) {
    // Include all normalized visible data: clocks, shots, strength, goalie
    // substitutions and corrected play text can change without a goal.
    return JSON.stringify([stateObj && stateObj.state, stateObj && stateObj.attributes, this.config]);
  }

  render() {
    if (!this._hass || !this.config || !this.content) return;
    if (!this.config.entity) {
      this.content.innerHTML = '<div class="empty">Configure this card — choose an NHL Live Scoreboard entity.</div>';
      return;
    }
    const stateObj = this._hass.states[this.config.entity];
    if (!stateObj) {
      this.content.innerHTML = '<div class="empty">Entity not found: ' + escapeHtml(this.config.entity) + '</div>';
      return;
    }
    const liveAttrs = stateObj.attributes || {};
    const liveId = String(liveAttrs.display_event_id || "");
    if (this._navAnchorId !== undefined && this._navAnchorId !== liveId) this._resetScheduleNav();
    this._navAnchorId = liveId;
    const periodAnchor = liveId + "|" + String(liveAttrs.current_period && liveAttrs.current_period.id || liveAttrs.period_context && liveAttrs.period_context.period || "");
    if (this._periodAnchorKey !== undefined && this._periodAnchorKey !== periodAnchor) this._resetPeriodNav();
    this._periodAnchorKey = periodAnchor;
    const navActive = this._navOffset !== 0 && !!this._navGameData;
    const attrs = navActive ? this._navGameData : liveAttrs;
    this._displayAttrs = attrs;
    const gameKey = String(attrs.display_event_id || attrs.competition && attrs.competition.id || "");
    if (this._liveExpandedGameKey !== gameKey) {
      this._liveExpandedGameKey = gameKey;
      this._liveExpanded = this._liveDefaultExpanded();
    }
    const fp = this._computeRenderFingerprint({state: stateObj.state, attributes: attrs}) +
      "|" + JSON.stringify([this._navOffset,this._navHasPrev,this._navHasNext,
        this._periodOffset,this._periodHasPrev,this._periodView,this._liveExpanded,this._upcomingExpanded]);
    if (fp === this._lastFingerprint) return;
    this._lastFingerprint = fp;
    const competition = attrs.competition || {};
    const competitors = competition.competitors || [];
    if (!competitors.length) {
      this.content.innerHTML = '<div class="empty">' +
        (stateObj.state === "unavailable" ? "NHL game data is temporarily unavailable." :
          "No NHL game is currently available for " + escapeHtml(attrs.team_name || attrs.team_abbr || "this team") + ".") + '</div>';
      return;
    }
    const away = competitors.find((c) => c.homeAway === "away") || {};
    const home = competitors.find((c) => c.homeAway === "home") || {};
    const awayTeam = away.team || {}, homeTeam = home.team || {};
    const awayMeta = attrs.away_team || {}, homeMeta = attrs.home_team || {};
    const stateInfo = deriveGameState(attrs);
    const live = stateInfo.pillClass === "live";
    const collapsed = live && !this._liveExpanded;
    const history = !navActive && this._periodOffset !== 0 ? this._periodView : null;
    const contextAttrs = history ? {
      ...attrs, period_context: history.period_context || attrs.period_context,
      current_period: history.current_period || {},
      recent_plays: history.recent_plays || [],
      situation: history.situation || {},
    } : attrs;
    const ctx = periodContext(contextAttrs);
    const awayScore = history ? parseScore(history.away_score) : parseScore(away.score);
    const homeScore = history ? parseScore(history.home_score) : parseScore(home.score);
    const awayRecord = this.config.show_records ? competitorRecord(away, awayMeta) : "";
    const homeRecord = this.config.show_records ? competitorRecord(home, homeMeta) : "";
    if (["next", "final", "postponed"].includes(stateInfo.pillClass)) {
      if (this._upcomingExpandedGameKey !== gameKey) {
        this._upcomingExpandedGameKey = gameKey;
        this._upcomingExpanded = false;
      }
      const html = this.renderCompactNonLive(stateInfo, competition,
        awayTeam, awayMeta, awayRecord, awayScore,
        homeTeam, homeMeta, homeRecord, homeScore, attrs,
        stateInfo.pillClass !== "postponed" && this._upcomingExpanded === true);
      if (html !== null) this.content.innerHTML = html;
      this._refreshOpenTeamPopup();
      return;
    }
    const ownerId = String(attrs.team_id || "");
    const ownerSide = ownerId && ownerId === String(homeMeta.id || homeTeam.id || "") ||
      String(attrs.team_abbr || "").toUpperCase() === String(homeMeta.abbreviation || homeTeam.abbreviation || "").toUpperCase() ? "home" : "away";
    const otherSide = ownerSide === "home" ? "away" : "home";
    const powerPlay = powerPlaySide(contextAttrs);
    const marker = this.renderPeriodMarker(stateInfo, ctx, !!history);
    const scoreboard = '<div class="scoreboard-main"><div class="scoreboard scoreboard-rich">' +
      this.teamRow(awayTeam,awayMeta,"",awayScore,false,false,powerPlay === "away") +
      this.teamRow(homeTeam,homeMeta,"",homeScore,false,true,powerPlay === "home") +
      '</div><div class="period-marker-side"><div class="period-marker-wrap"><div class="period-marker ' +
      (history ? "history" : stateInfo.pillClass) + '">' + marker + '</div></div></div></div>';
    const header = live ? '<div class="live-expandable' + (!collapsed ? " expanded" : "") + '" role="button" tabindex="0" aria-expanded="' +
      (!collapsed) + '" title="' + (collapsed ? "Show game details" : "Hide game details") + '">' +
      scoreboard + '<div class="live-expand-strip"><span class="tri ' + (collapsed ? "tri-down" : "tri-up") + '"></span></div></div>' : scoreboard;
    const win = live && !collapsed && !history && this.config.show_win_probability !== false ?
      renderWinProbabilityRow(attrs.win_probability,ownerSide,teamAbbreviation(attrs,ownerSide),teamAbbreviation(attrs,otherSide)) : "";
    const delayed = stateInfo.pillClass === "delayed" ? '<div class="state-panel delayed-panel"><span class="mini-state warning">DLY</span><span>' +
      escapeHtml(stateInfo.statusText || "Game delayed") + '</span></div>' : "";
    let extras = "";
    if (live && !collapsed) {
      const breakLeaders = !history && this.config.show_matchup !== false && (ctx.is_intermission || ctx.is_end_period) ?
        renderIntermissionLeaders(this,attrs,ownerSide) : "";
      const matchup = !history && !breakLeaders && this.config.show_matchup !== false ? renderGoalieMatchup(this,attrs,false) :
        !history && !breakLeaders && this.config.show_rink !== false ? '<div class="nhl-rink-only">' + renderRink(attrs,[],false) + '</div>' : "";
      let plays = renderRecentPlays(contextAttrs.recent_plays || [],this.config);
      if (this.config.show_period_nav !== false && this.config.show_plays !== false) {
        plays = renderPeriodStrip(plays,!history,history ? !this._periodHasPrev : false);
      }
      const historyLabel = history ? '<div class="nhl-history-label">Earlier period · ' + escapeHtml([periodLabel(ctx.period,ctx),!ctx.is_shootout && ctx.display_clock].filter(Boolean).join(" ")) + '</div>' : "";
      extras = '<div class="live-panel productionish">' + historyLabel +
        (!history && !breakLeaders && this.config.show_situation !== false ? renderSituationRow(attrs.situation,teamAbbreviation(attrs,"away"),teamAbbreviation(attrs,"home")) : "") +
        (breakLeaders || matchup) +
        (this.config.show_period_summary !== false ? renderPeriodSummary(contextAttrs.current_period) : "") +
        (!history && this.config.show_strength !== false ? renderStrengthRow(attrs) : "") +
        (this.config.show_shot_chart === true ? renderRink(contextAttrs,contextAttrs.recent_plays || [],true) : "") +
        plays + '</div>';
    }
    const html = '<div class="wrapper ' + this._headshotSizeClass() + '">' + header + win +
      (this.config.show_linescore && !collapsed ? this.renderLinescore(competition,history,contextAttrs) : "") + delayed + extras + '</div>';
    if (html !== this._lastLiveHtml) {
      this._lastLiveHtml = html;
      const playKey = gameKey + "|" + ctx.period + "|" + this._periodOffset;
      const oldPanel = this.content.querySelector(".plays-panel");
      const samePeriod = this._renderedPlayKey === playKey;
      const scroll = samePeriod && oldPanel ? oldPanel.scrollTop || 0 : 0;
      const oldHeight = oldPanel ? oldPanel.scrollHeight || 0 : 0;
      const focused = oldPanel && deepActiveElement() === oldPanel;
      this.content.innerHTML = html;
      this._renderedPlayKey = playKey;
      const panel = this.content.querySelector(".plays-panel");
      if (panel) {
        // Keep the latest action visible at the top, but preserve a reader's
        // place and keyboard focus while new plays arrive above older ones.
        if (focused) panel.focus({preventScroll: true});
        panel.scrollTop = scroll > 0 ? scroll + Math.max(0, (panel.scrollHeight || 0) - oldHeight) : 0;
      }
    }
    this._refreshOpenTeamPopup();
  }

  _refreshOpenTeamPopup() {
    if (this._isLineupPopupOpen() && this._luView === "game") this._renderLineupBody();
  }

  formatCompactDateTime(dateValue) {
    const d = dateValue ? new Date(dateValue) : null;
    if (!d || Number.isNaN(d.getTime()))
      return { date: "", time: "", isToday: false };
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const isToday = startOfTarget.getTime() === startOfToday.getTime();
    const dayDiff = Math.round((startOfTarget - startOfToday) / 86400000);
    const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dateText =
      dayDiff > 0 && dayDiff <= 7
        ? DAY_ABBR[d.getDay()]
        : `${d.getMonth() + 1}/${d.getDate()}`;
    return {
      date: dateText,
      time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      isToday,
    };
  }

  renderCompactNonLive(
    stateInfo,
    competition,
    awayTeam,
    awayMeta,
    awayRecord,
    awayScore,
    homeTeam,
    homeMeta,
    homeRecord,
    homeScore,
    attrs = {},
    expanded = false,
  ) {
    // Compute a compact-specific fingerprint to avoid unnecessary DOM updates
    const isUpcoming = stateInfo.pillClass === "next";
    const isFinalCompact = stateInfo.pillClass === "final";
    const canExpand = isUpcoming || isFinalCompact;
    const compactFp = [
      stateInfo.pillClass,
      awayTeam?.abbreviation || awayMeta?.abbreviation,
      homeTeam?.abbreviation || homeMeta?.abbreviation,
      competition?.date,
      awayScore.text,
      homeScore.text,
      awayRecord,
      homeRecord,
      expanded ? "exp" : "col",
      canExpand ? this._upcomingDetailsFingerprint(attrs) : "",
      `nav:${this._navOffset}:${this._navHasPrev ? 1 : 0}${this._navHasNext ? 1 : 0}`,
    ].join("|");
    if (compactFp === this._lastCompactFp) {
      return null; // DOM already reflects this state — skip the update
    }
    this._lastCompactFp = compactFp;

    const when = this.formatCompactDateTime(competition?.date);
    const awayLogo = requestCachedLogo(
      this,
      awayTeam?.logo ||
        get(awayTeam, ["logos", 0, "href"], "") ||
        awayMeta?.logo ||
        "",
    );
    const homeLogo = requestCachedLogo(
      this,
      homeTeam?.logo ||
        get(homeTeam, ["logos", 0, "href"], "") ||
        homeMeta?.logo ||
        "",
    );
    const awayName =
      awayTeam?.name ||
      awayTeam?.displayName ||
      awayTeam?.shortDisplayName ||
      awayMeta?.name ||
      awayMeta?.short_name ||
      awayTeam?.abbreviation ||
      "—";
    const homeName =
      homeTeam?.name ||
      homeTeam?.displayName ||
      homeTeam?.shortDisplayName ||
      homeMeta?.name ||
      homeMeta?.short_name ||
      homeTeam?.abbreviation ||
      "—";
    const isFinal = stateInfo.pillClass === "final";
    const isPostponed = stateInfo.pillClass === "postponed";
    const awayWon =
      isFinal &&
      awayScore.num != null &&
      homeScore.num != null &&
      awayScore.num > homeScore.num;
    const homeWon =
      isFinal &&
      awayScore.num != null &&
      homeScore.num != null &&
      homeScore.num > awayScore.num;
    const finalMarker = `<div class="compact-final-marker">${
      when.date
        ? `<div class="compact-date compact-final-date">${when.date}</div>`
        : ""
    }</div>`;
    const postponedMarker = `<div class="compact-final-marker"><div class="compact-pill compact-pill-postponed">PPD</div></div>`;
    const nextRight = when.isToday
      ? `<div class="compact-next-wrap today-only">
          <div class="compact-time">${when.time || ""}</div>
        </div>`
      : `<div class="compact-next-wrap">
          <div class="compact-date">${when.date || ""}</div>
          <div class="compact-time">${when.time || ""}</div>
        </div>`;
    const rightHtml = isPostponed
      ? postponedMarker
      : isFinal
        ? finalMarker
        : nextRight;
    const expandable = isUpcoming || isFinalCompact;
    const detailsPanel =
      expandable && expanded
        ? renderUpcomingDetails(
            this,
            attrs,
            awayMeta,
            homeMeta,
            awayLogo,
            homeLogo,
            { kind: isUpcoming ? "upcoming" : "final" },
          )
        : "";
    const expandTitle = isUpcoming
      ? expanded
        ? "Hide details"
        : "Show goalies & standings"
      : expanded
        ? "Hide game summary"
        : "Show game summary";
    // Prev/next schedule arrows flank the date/status. Hidden via config; the
    // whole branch is already non-live so no extra live-state guard is needed.
    // Optimistic-enabled at offset 0 (we don't hold the full schedule
    // client-side); the backend's has_prev/has_next disable them at the ends.
    const showScheduleNav = this.config?.show_schedule_nav !== false;
    const prevDisabled = !this._navHasPrev;
    const nextDisabled = !this._navHasNext;
    const markerCore = `<div class="period-marker-wrap">${rightHtml}</div>`;
    const innerMarkerSide = showScheduleNav
      ? `<button class="schedule-nav-btn schedule-nav-prev" type="button" aria-label="Previous game" title="Previous game"${prevDisabled ? " disabled" : ""}>‹</button>${markerCore}<button class="schedule-nav-btn schedule-nav-next" type="button" aria-label="Next game" title="Next game"${nextDisabled ? " disabled" : ""}>›</button>`
      : markerCore;
    const markerSide = `<div class="period-marker-side${showScheduleNav ? " has-schedule-nav" : ""}">${innerMarkerSide}</div>`;
    const wrapperClasses = [
      "wrapper",
      "compact-mode",
      this._headshotSizeClass(),
    ];
    if (expandable) wrapperClasses.push("upcoming-expandable");
    if (expanded) wrapperClasses.push("expanded");
    const html = `
      <div class="${wrapperClasses.join(" ")}"${expandable ? ` role="button" tabindex="0" aria-expanded="${expanded ? "true" : "false"}" title="${expandTitle}"` : ""}>
        <div class="scoreboard-main">
          <div class="scoreboard scoreboard-rich">
            <div class="team-row away ${awayWon ? "winner" : ""}">
              <div class="team-left">
                ${awayLogo ? `<img class="logo" src="${escapeHtml(awayLogo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<div class="logo placeholder"></div>`}
                <div class="meta">
                  <div class="name">${escapeHtml(awayName)}${awayRecord ? ` <span class="record-inline">(${escapeHtml(awayRecord)})</span>` : ""}</div>
                </div>
              </div>
              ${isFinal ? `<div class="team-right compact-final-score-right"><div class="score final-score">${escapeHtml(awayScore.text || "—")}</div></div>` : ""}
            </div>
            <div class="team-row home ${homeWon ? "winner" : ""}">
              <div class="team-left">
                ${homeLogo ? `<img class="logo" src="${escapeHtml(homeLogo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<div class="logo placeholder"></div>`}
                <div class="meta">
                  <div class="name">${escapeHtml(homeName)}${homeRecord ? ` <span class="record-inline">(${escapeHtml(homeRecord)})</span>` : ""}</div>
                </div>
              </div>
              ${isFinal ? `<div class="team-right compact-final-score-right"><div class="score final-score">${escapeHtml(homeScore.text || "—")}</div></div>` : ""}
            </div>
          </div>
          ${markerSide}
        </div>
        ${detailsPanel}
      </div>`;
    // Identical output (e.g. a forced repaint whose time-derived text didn't
    // actually change) — skip the DOM write but keep the new fingerprint.
    if (html === this._lastCompactHtml) return null;
    this._lastCompactHtml = html;
    return html;
  }


  renderPeriodMarker(stateInfo, context, history) {
    if (stateInfo.pillClass === "delayed") return '<div class="marker-text">DLY</div>';
    if (stateInfo.pillClass === "postponed") return '<div class="marker-text">PPD</div>';
    if (stateInfo.pillClass === "final") return '<div class="marker-text">F</div>';
    if (stateInfo.pillClass !== "live") return "";
    const label = context.is_intermission && !history ? "INT" : periodLabel(context.period, context) || "LIVE";
    return '<div class="period-stack nhl-period-stack"><div class="num">' + escapeHtml(label) + '</div>' +
      (context.display_clock && !context.is_intermission && !context.is_shootout ? '<div class="nhl-clock">' + escapeHtml(context.display_clock) + '</div>' : "") + '</div>';
  }

  teamRow(team, teamMeta, record, score, winner, isHome, hasPowerPlay) {
    const raw = team.logo || get(team,["logos",0,"href"],"") || teamMeta.logo || "";
    const logo = requestCachedLogo(this,raw);
    const name = team.name || team.displayName || team.shortDisplayName || teamMeta.name || teamMeta.short_name || team.abbreviation || "—";
    return '<div class="team-row ' + (winner ? "winner " : "") + (isHome ? "home" : "away") + '"><div class="team-left">' +
      (logo ? '<img class="logo" src="' + escapeHtml(logo) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '<div class="logo placeholder"></div>') +
      '<div class="meta"><div class="name">' + escapeHtml(name) +
      (record ? ' <span class="record-inline">(' + escapeHtml(record) + ')</span>' : "") +
      '</div></div></div><div class="team-right nhl-score-values">' +
      (hasPowerPlay ? '<span class="nhl-power-play" aria-label="Power play" title="Power play">PP</span>' : '<span class="nhl-strength-space"></span>') +
      '<div class="score rhe-score">' + escapeHtml(score.text || "—") + '</div></div></div>';
  }
}


const CARD_STYLE_ID = "nhl-live-game-card-style";
const CARD_CSS = `nhl-live-game-card .wrapper {
          padding: 0 1px 0;

          container-type: inline-size;
          container-name: nhl-card;
        }nhl-live-game-card .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          margin-bottom: 6px;
        }nhl-live-game-card .title-wrap {
          display:flex;
          align-items:center;
          gap:6px;
          min-width:0;
        }nhl-live-game-card .title {
line-height: 1.2;
        }nhl-live-game-card .version {
line-height:1;
          color: var(--secondary-text-color);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 999px;
          padding: 2px 6px;
        }nhl-live-game-card .pill {
border-radius: 999px;
          padding: 4px 8px;
          background: transparent;
        }nhl-live-game-card .pill.live { color: var(--success-color); }nhl-live-game-card .pill.delayed { color: var(--warning-color); }nhl-live-game-card .pill.final { color: var(--primary-text-color); }nhl-live-game-card .pill.postponed { color: var(--warning-color); }nhl-live-game-card .pill.next { color: var(--secondary-text-color); }nhl-live-game-card .pill.idle { color: var(--secondary-text-color); }nhl-live-game-card .status {
          color: var(--secondary-text-color);
line-height: 1.25;
          margin-bottom: 10px;
        }nhl-live-game-card .scoreboard {
          display: grid;
          gap: 0;
        }nhl-live-game-card .scoreboard-rich {
          grid-template-columns: minmax(0, 1fr);
        }nhl-live-game-card .team-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 1px 0;
          border-top: none;
          opacity: 0.9;
}nhl-live-game-card .team-row.winner {
          opacity: 1;
        }nhl-live-game-card .team-row.winner .name,
nhl-live-game-card .team-row.winner .score {
}nhl-live-game-card .team-row:first-child {
          border-top: none;
        }nhl-live-game-card .team-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }nhl-live-game-card .logo {
          width: 28px;
          height: 28px;
          object-fit: contain;
          flex: 0 0 28px;
        }nhl-live-game-card .logo.placeholder {
          border-radius: 50%;
          background: rgba(255,255,255,0.08);
        }nhl-live-game-card .player-shot {

          width: clamp(40px, 14cqi, 128px);

          aspect-ratio: 1 / 1;
          object-fit: cover;
          border-radius: 50%;

          flex: 0 0 auto;
          background: rgba(255,255,255,0.06);
        }nhl-live-game-card .player-shot.placeholder {
          background: rgba(255,255,255,0.08);
        }nhl-live-game-card .meta {
          min-width: 0;
        }nhl-live-game-card .name {
          line-height: 1.15;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: 16px !important;
          font-weight: 500;
        }nhl-live-game-card .record {
color: var(--secondary-text-color);
          line-height: 1.15;
        }nhl-live-game-card .record-inline {
color: var(--primary-text-color);
          opacity: 0.92;
          font-size: 0.9em;
          font-weight: 400;
}nhl-live-game-card .team-right {
          display:flex;
          align-items:center;
          gap:6px;
          margin-left:auto;
        }nhl-live-game-card .rhe-header {
          display:flex;
          align-items:center;
          justify-content:space-between;
          margin: 0 0 -1px;
          color: var(--secondary-text-color);
line-height: 1;
          padding: 0 0 2px;
        }nhl-live-game-card .rhe-spacer {
          flex: 1 1 auto;
        }nhl-live-game-card .rhe-cols,
nhl-live-game-card .rhe-values {
          display:grid;
          grid-template-columns: 28px 22px 22px;
          align-items:center;
          justify-items:end;
          column-gap: 8px;
          white-space: nowrap;
        }nhl-live-game-card .rhe-col {
          text-align:right;
}nhl-live-game-card .rhe-col.score {
}nhl-live-game-card .rhe-score,
nhl-live-game-card .score {
min-width: 20px;
          text-align: right;
          font-variant-numeric: tabular-nums;
          font-size: 1.05em;
          font-weight: 500;
}nhl-live-game-card .rhe-num {
color: var(--primary-text-color);
          font-variant-numeric: tabular-nums;
          text-align:right;
          font-size: 1.05em;
          font-weight: 500;
        }nhl-live-game-card .scoreboard-main {
          display:grid;
          grid-template-columns:minmax(0,1fr) auto;
          column-gap:6px;
          align-items:start;
        }nhl-live-game-card .period-marker-side {
          display:flex;
          align-items:center;
          justify-content:center;
          align-self:stretch;
          min-width:28px;
          padding-top: 0;
        }nhl-live-game-card .period-marker-side.has-schedule-nav {
          gap: 2px;
          min-width: 64px;
        }nhl-live-game-card .schedule-nav-btn {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 28px;
          padding: 0;
          margin: 0;
          border: none;
          background: none;
          cursor: pointer;
          font-size: 1.4em;
          line-height: 1;
          color: var(--secondary-text-color);
          border-radius: 4px;
          -webkit-tap-highlight-color: transparent;
        }nhl-live-game-card .schedule-nav-btn:hover:not([disabled]) {
          color: var(--primary-text-color);
          background: var(--secondary-background-color);
        }nhl-live-game-card .schedule-nav-btn:focus-visible {
          outline: 2px solid var(--primary-color);
          outline-offset: 1px;
        }nhl-live-game-card .schedule-nav-btn[disabled] {
          opacity: 0.25;
          cursor: default;
        }nhl-live-game-card .period-strip {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 24px;

          margin: 2px 0 -12px;
          padding: 2px 0;
          border-top: 1px solid var(--divider-color, rgba(127,127,127,0.2));
        }nhl-live-game-card .period-nav-btn {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 9px;
          padding: 0;
          margin: 0;
          border: none;
          background: none;
          cursor: pointer;
          color: var(--secondary-text-color);
          border-radius: 4px;
          -webkit-tap-highlight-color: transparent;
        }nhl-live-game-card .period-nav-btn .tri,
nhl-live-game-card .live-expand-strip .tri {
          width: 0;
          height: 0;
          border-left: 6px solid transparent;
          border-right: 6px solid transparent;
        }nhl-live-game-card .period-nav-btn .tri-down,
nhl-live-game-card .live-expand-strip .tri-down { border-top: 7px solid currentColor; }nhl-live-game-card .period-nav-btn .tri-up,
nhl-live-game-card .live-expand-strip .tri-up { border-bottom: 7px solid currentColor; }nhl-live-game-card .period-nav-btn:hover:not([disabled]) {
          color: var(--primary-text-color);
          background: var(--secondary-background-color);
        }nhl-live-game-card .period-nav-btn:focus-visible {
          outline: 2px solid var(--primary-color);
          outline-offset: 1px;
        }nhl-live-game-card .period-nav-btn[disabled] {
          opacity: 0.25;
          cursor: default;
        }nhl-live-game-card .period-marker-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          margin: 0;
          gap: 0;
          min-height: 100%;
          height: 100%;
        }nhl-live-game-card .period-marker {
          min-width: 20px;
          text-align: center;
border-radius: 0;
          padding: 0;
          background: none;
          color: var(--secondary-text-color);
        }nhl-live-game-card .period-marker.live { color: var(--success-color); }nhl-live-game-card .period-marker.history { color: var(--info-color, #4a90d9); }nhl-live-game-card .period-marker.delayed { color: var(--warning-color); }nhl-live-game-card .period-marker.final { color: var(--primary-text-color); }nhl-live-game-card .period-marker.postponed { color: var(--warning-color); }nhl-live-game-card .period-stack {
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          line-height:1;
          gap:0px;
        }nhl-live-game-card .period-stack .arrow,
nhl-live-game-card .period-stack .num,
nhl-live-game-card .marker-text {
line-height: 1;
        }nhl-live-game-card .period-stack .num {
          font-variant-numeric: tabular-nums;
        }nhl-live-game-card .marker-text {
          display:block;
          min-width: 16px;
          text-align:center;
        }nhl-live-game-card .state-panel {
          border-top: 1px solid rgba(255,255,255,0.08);
          margin-top: 10px;
          padding-top: 8px;
color: var(--secondary-text-color);
          text-align: center;
        }nhl-live-game-card .delayed-panel { color: var(--warning-color); }nhl-live-game-card .final-panel { color: var(--secondary-text-color); }nhl-live-game-card .matchup-block {
          border-top: 0;
          margin-top: 6px;
          padding: 6px 0 0;
        }nhl-live-game-card .matchup-grid {
          display:grid;
          grid-template-columns: minmax(0,1fr) minmax(0,1fr);
          gap: 24px;
          align-items:start;
        }nhl-live-game-card .matchup-grid.enhanced {

          grid-template-columns: minmax(0,1fr) clamp(56px, 14cqi, 100px) minmax(0,1fr);
          column-gap: 0;
          row-gap: 0;
          align-items:start;
        }nhl-live-game-card .matchup-grid.enhanced.with-pitch-zone {
          grid-template-columns: minmax(0,1fr) clamp(140px, 42cqi, 260px) minmax(0,1fr);
        }nhl-live-game-card .matchup-center {
          display:flex;
          align-items:center;
          justify-content:center;
        }nhl-live-game-card .matchup-center.stack-center {
          flex-direction: column;
          gap: 0;
          align-self: start;
          justify-content: flex-start;
        }nhl-live-game-card .matchup-center.stack-center > .diamond-center {
          min-height: 0;
        }nhl-live-game-card .diamond-center {
          align-self:center;
          min-height: 70px;
        }nhl-live-game-card .pitch-zone {
          width: clamp(120px, 36cqi, 240px);
          aspect-ratio: 220 / 190;
          display: flex;
          align-items: center;
          justify-content: center;
        }nhl-live-game-card .pitch-zone svg {
          width: 100%;
          height: 100%;
          overflow: visible;
        }nhl-live-game-card .pitch-zone-frame {
          fill: rgba(255,255,255,0.04);
          stroke: rgba(255,255,255,0.55);
          stroke-width: 1.5;
        }nhl-live-game-card .pitch-zone-plate {
          fill: rgba(255,255,255,0.55);
          stroke: rgba(255,255,255,0.75);
          stroke-width: 1;
        }nhl-live-game-card .pitch-zone-dot circle {
          filter: drop-shadow(0 0 1px rgba(0,0,0,0.45));
        }nhl-live-game-card .diamond-graphic {
          position: relative;

          width: clamp(44px, 13cqi, 88px);

          aspect-ratio: 1 / 1;
          display:flex;
          align-items:center;
          justify-content:center;
        }nhl-live-game-card .diamond-field {
          position:absolute;
          inset: 12.5%;
          border: 2px solid rgba(255,255,255,0.56);
          border-radius: 2px;
          transform: rotate(45deg);
          box-sizing:border-box;
          background: rgba(255,255,255,0.03);
        }nhl-live-game-card .diamond-base {
          position:absolute;
          width: 17.9%;
          aspect-ratio: 1 / 1;
          background: rgba(255,255,255,0.24);
          border: 1px solid rgba(255,255,255,0.42);
          transform: rotate(45deg);
          box-sizing:border-box;
          border-radius: 1px;
        }nhl-live-game-card .diamond-base.on {
          background: #63a2ff;
          border-color: rgba(255,255,255,0.70);
          box-shadow: 0 0 0 1px rgba(99,162,255,0.22);
        }nhl-live-game-card .diamond-base.home { bottom: 1.8%; left: 50%; margin-left: -8.95%; }nhl-live-game-card .diamond-base.first { top: 50%; right: 1.8%; margin-top: -8.95%; }nhl-live-game-card .diamond-base.second { top: 1.8%; left: 50%; margin-left: -8.95%; }nhl-live-game-card .diamond-base.third { top: 50%; left: 1.8%; margin-top: -8.95%; }nhl-live-game-card .diamond-mound {
          position:absolute;
          width: 10.7%;
          aspect-ratio: 1 / 1;
          border-radius: 50%;
          background: rgba(255,255,255,0.48);
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
        }nhl-live-game-card .matchup-divider {
          width:1px;
          align-self:stretch;
          justify-self:center;
          background: transparent;
        }nhl-live-game-card .matchup-side {
          min-width:0;
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:flex-start;
          text-align:center;
        }nhl-live-game-card .matchup-side.centered {
          text-align:center;
        }nhl-live-game-card .matchup-side[data-team-popup] {
          cursor: pointer;
          border-radius: 6px;
        }nhl-live-game-card .matchup-side[data-team-popup]:hover {
          background: var(--secondary-background-color, rgba(255,255,255,0.06));
        }nhl-live-game-card .matchup-side[data-team-popup]:focus-visible {
          outline: 2px solid var(--warning-color, #ffb300);
          outline-offset: 2px;
        }nhl-live-game-card .matchup-copy.centered {
          width:100%;
          text-align:center;
        }nhl-live-game-card .matchup-value {
          margin-top: 4px;
line-height:1.15;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--warning-color);
        }nhl-live-game-card .player-link {
          color: inherit;
          cursor: pointer;
          text-decoration: none;
        }nhl-live-game-card .player-link:hover { text-decoration: underline; }nhl-live-game-card .player-link:focus-visible {
          outline: 2px solid var(--warning-color);
          outline-offset: 1px;
          border-radius: 2px;
        }nhl-live-game-card .stat-line {
color: var(--primary-text-color) !important;
        }nhl-live-game-card .matchup-subtle {
          margin-top: 3px;
line-height:1.16;
          color: var(--secondary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }nhl-live-game-card .label,
nhl-live-game-card .subtle {
          color: var(--secondary-text-color);
        }nhl-live-game-card .value {
}nhl-live-game-card .subtle {
          margin-top: 4px;
line-height: 1.2;
        }nhl-live-game-card .muted-block .value {
          color: var(--secondary-text-color);
}nhl-live-game-card .live-panel,
nhl-live-game-card .state-panel {
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }nhl-live-game-card .win-prob-row {
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }nhl-live-game-card .win-prob-bar {
          position: relative;
          width: 100%;
          height: 20px;
          border-radius: 10px;
          overflow: hidden;
          background: #c0392b;
          font-size: 0.86em;
          line-height: 20px;
          font-variant-numeric: tabular-nums;
        }nhl-live-game-card .win-prob-fill {
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          background: #1d6bd6;
        }nhl-live-game-card .win-prob-label {
          position: absolute;
          top: 0;
          bottom: 0;
          display: inline-flex;
          align-items: center;
          color: #ffffff;
          font-weight: 800;
          letter-spacing: 0.02em;
          white-space: nowrap;
          pointer-events: none;
          text-shadow:
            0 0 2px rgba(0,0,0,0.85),
            0 1px 2px rgba(0,0,0,0.7),
            0 0 1px rgba(0,0,0,0.9);
        }nhl-live-game-card .win-prob-label-owner { left: 10px; }nhl-live-game-card .win-prob-label-opponent { right: 10px; }nhl-live-game-card .live-strip {
          display: grid;
          grid-template-columns: max-content 1fr max-content;
          gap: 10px;
          align-items: center;
        }nhl-live-game-card .mini-state {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 34px;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(255,255,255,0.08);
line-height: 1;
        }nhl-live-game-card .mini-state.strong {
          color: var(--success-color);
        }nhl-live-game-card .mini-state.warning {
          color: var(--warning-color);
        }nhl-live-game-card .count-summary,
nhl-live-game-card .bases-summary {
line-height: 1.2;
        }nhl-live-game-card .count-summary {
          color: var(--primary-text-color);
}nhl-live-game-card .bases-summary {
          color: var(--secondary-text-color);
          text-align: right;
          white-space: nowrap;
        }nhl-live-game-card .period-sub {
color: var(--secondary-text-color);
          line-height: 1;
        }nhl-live-game-card .count-dots-row {
          margin-top: 2px;
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px 8px;
}nhl-live-game-card .on-deck-row {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 6px;
          margin-top: 6px;
          padding-top: 2px;
          font-size: 0.85em;
          line-height: 1.15;
        }nhl-live-game-card .on-deck-label {
          color: var(--secondary-text-color);
        }nhl-live-game-card .on-deck-name {
          color: var(--warning-color);
          font-weight: 500;
        }nhl-live-game-card .on-deck-stats {
          color: var(--secondary-text-color);
          font-size: 0.9em;
        }nhl-live-game-card .bases-occupancy-row {
          margin-top: 6px;
          padding-top: 2px;
          display:grid;
          grid-template-columns: repeat(3, minmax(0,1fr));
          column-gap: 10px;
          align-items:center;
line-height: 1.15;
        }nhl-live-game-card .base-slot {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }nhl-live-game-card .base-slot:nth-child(1) { text-align:left; }nhl-live-game-card .base-slot:nth-child(2) { text-align:center; }nhl-live-game-card .base-slot:nth-child(3) { text-align:right; }nhl-live-game-card .base-label {
          color: var(--secondary-text-color);
}nhl-live-game-card .base-value {
}nhl-live-game-card .base-value.empty-value {
          color: var(--secondary-text-color); }nhl-live-game-card .base-value.occupied-value {
color: var(--primary-text-color); }nhl-live-game-card .count-dots-row.prominent {
          margin-top: 0;
          padding: 0 0 3px;
          justify-content: center;
          gap: 12px 18px;
        }nhl-live-game-card .count-pack {
          display:inline-flex;
          align-items:center;
          gap:6px;
        }nhl-live-game-card .dots-label {
          color: var(--secondary-text-color);
        }nhl-live-game-card .dots-label.verbose {
color: var(--primary-text-color);
        }nhl-live-game-card .count-dots-row.verbose {
          justify-content: space-between;
          gap: 10px;
        }nhl-live-game-card .dots {
          display: inline-flex;
          gap: 4px;
          margin-right: 4px;
        }nhl-live-game-card .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: rgba(255,255,255,0.14);
          display: inline-block;
        }nhl-live-game-card .dot.ball.on { background: #4fc3f7; }nhl-live-game-card .dot.strike.on { background: #ffb74d; }nhl-live-game-card .dot.out.on { background: #ef5350; }nhl-live-game-card .muted {
          color: var(--secondary-text-color);
          margin-left: 6px;
        }nhl-live-game-card .totals-inline {
          color: var(--secondary-text-color);
          margin-left: 6px;
}nhl-live-game-card .plays-panel {
          max-height: 320px;
          overflow-y: auto;
          overscroll-behavior: contain;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.08);
          display: flex;
          flex-direction: column;
          gap: 4px;
        }nhl-live-game-card .plays-panel:focus-visible {
          outline: 2px solid var(--warning-color, #ffb300);
          outline-offset: -2px;
        }nhl-live-game-card .nhl-play-order {
          color: var(--secondary-text-color);
          font-size: .7em;
          text-align: right;
        }nhl-live-game-card .play-row {
          display: grid;
          grid-template-columns: minmax(0,1fr) max-content;
          gap: 10px;
          align-items: start;
line-height: 1.2;
}nhl-live-game-card .play-text {
          min-width: 0;
          white-space: normal;
          word-break: break-word;
          color: var(--primary-text-color);
        }nhl-live-game-card .pitch-row {
          grid-template-columns: minmax(0,1fr);
          margin-top: -2px;
          margin-bottom: -2px;
        }nhl-live-game-card .pitch-row .play-text {
          text-align: right;
          justify-self: stretch;
          color: var(--secondary-text-color);
          opacity: 0.88;
          width: 100%;
          margin-left: 0;
          padding-left: 0;
line-height: 1.05;
        }nhl-live-game-card .pitch-row .play-indicator { display: none; }nhl-live-game-card .pitch-velo-hot {
          color: #ff4d4d !important;
          font-weight: 700;
        }nhl-live-game-card .play-indicator {
          color: var(--secondary-text-color);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
}nhl-live-game-card .break-leaders-panel {
          margin-top: 10px;
          padding-top: 0;
          border-top: 0;
        }nhl-live-game-card .break-leaders-title {
          text-align: center;
color: var(--secondary-text-color);
          font-weight: 600;
          margin-bottom: 6px;
}nhl-live-game-card .break-leaders-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0,1fr));
          gap: 10px;
        }nhl-live-game-card .break-leaders-card {
          display:flex;
          flex-direction:column;
          align-items:center;
          text-align:center;
          gap:2px;
          min-width:0;
        }nhl-live-game-card .break-leaders-name {
line-height: 1.03;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
          color: var(--warning-color);
        }nhl-live-game-card .break-leaders-stat {
          margin-top: 1px;
          color: var(--secondary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }nhl-live-game-card .pregame-panel,
nhl-live-game-card .leaders-panel {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }nhl-live-game-card .pregame-matchup,
nhl-live-game-card .leaders-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }nhl-live-game-card .goalie-side,
nhl-live-game-card .leaders-col {
          min-width: 0;
        }nhl-live-game-card .subtle-inline {
          color: var(--secondary-text-color);
margin-left: 6px;
        }nhl-live-game-card .leaders-head {
margin-bottom: 6px;
          color: var(--secondary-text-color);
        }nhl-live-game-card .leader-item {
          display: grid;
          grid-template-columns: max-content 1fr max-content;
          gap: 6px;
          align-items: center;
line-height: 1.25;
          margin-top: 3px;
        }nhl-live-game-card .leader-cat {
          color: var(--secondary-text-color);
          white-space: nowrap;
        }nhl-live-game-card .leader-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--warning-color);
        }nhl-live-game-card .leader-val {
white-space: nowrap;
        }nhl-live-game-card .linescore {
          margin-top: 10px;
          border-top: 1px solid rgba(255,255,255,0.08);
          padding-top: 8px;
        }nhl-live-game-card .linescore-grid {
          display: grid;
          grid-template-columns: max-content repeat(9, minmax(18px, 1fr)) max-content;
          gap: 4px 6px;
          align-items: center;
}nhl-live-game-card .period-head,
nhl-live-game-card .period-cell,
nhl-live-game-card .period-total,
nhl-live-game-card .team-abbr {
          text-align: center;
        }nhl-live-game-card .period-head,
nhl-live-game-card .team-abbr {
          color: var(--secondary-text-color);
        }nhl-live-game-card .period-total {
}nhl-live-game-card .empty {
          padding: 16px;
          color: var(--secondary-text-color);
        }nhl-live-game-card .wrapper.compact-mode {
          padding: 0;
          margin: 0;
        }nhl-live-game-card .compact-board {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          column-gap: 8px;
          align-items: center;
          min-height: 32px;
        }nhl-live-game-card .compact-left {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }nhl-live-game-card .compact-team-row {
          display:flex;
          align-items:center;
          gap:6px;
          min-width:0;
          padding: 0;
          margin: 0;
        }nhl-live-game-card .compact-logo {
          width: 24px;
          height: 24px;
          object-fit: contain;
          flex: 0 0 24px;
          margin-top: 0;
          margin-bottom: 0;
        }nhl-live-game-card .compact-name {
line-height: 1.15;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin: 0;
          padding: 0;
}nhl-live-game-card .compact-record {
          color: var(--primary-text-color);
opacity: 0.92;
          margin: 0;
          padding: 0;
}nhl-live-game-card .compact-right {
          display:flex;
          align-items:center;
          justify-content:flex-end;
          min-width:58px;
        }nhl-live-game-card .compact-next-wrap {
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:0px;
          line-height:1;
        }nhl-live-game-card .compact-next-wrap.today-only {
          justify-content:center;
          height:100%;
        }nhl-live-game-card .compact-final-wrap {
          display:flex;
          flex-direction:row;
          align-items:center;
          justify-content:flex-end;
          gap:6px;
          line-height:1.05;
        }nhl-live-game-card .compact-date,
nhl-live-game-card .compact-score {
white-space: nowrap;
          line-height: 1.08;
        }nhl-live-game-card .compact-final-scores {
          display:flex;
          flex-direction:column;
          align-items:flex-end;
          justify-content:center;
          gap:1px;
        }nhl-live-game-card .compact-next-wrap .compact-date,
nhl-live-game-card .compact-next-wrap .compact-time {
          white-space: nowrap;
          line-height: 1.05;
          font-size: 1em !important;
          font-weight: 400 !important;
        }nhl-live-game-card .compact-next-wrap.today-only .compact-time {
          font-size: 1em !important;
          font-weight: 500 !important;
        }nhl-live-game-card .compact-pill {
color: var(--secondary-text-color);
white-space: nowrap;
          min-width: 12px;
          text-align:center;
        }nhl-live-game-card .compact-final-date {
          font-size: 1em;
          font-weight: 400;
        }nhl-live-game-card .compact-pill-postponed {
          display:flex;
          align-items:center;
          align-self:center;
          min-height: 34px;
          color: var(--warning-color);
          font-size: 0.85em;
        }nhl-live-game-card .compact-final-marker {
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:1px;
          height:100%;
        }nhl-live-game-card .compact-final-score-right {
          display:flex;
          align-items:center;
          justify-content:flex-end;
          margin-left:auto;
        }nhl-live-game-card .final-score {
          font-size:1.2em;
          font-weight:600;
          min-width:28px;
          text-align:right;
        }nhl-live-game-card .compact-mode .team-row.winner .final-score {
          color: var(--primary-color, #03a9f4);
        }nhl-live-game-card .live-expandable {
          cursor: pointer;
          outline: none;
          -webkit-tap-highlight-color: transparent;
        }nhl-live-game-card .live-expandable:focus-visible {
          box-shadow: 0 0 0 2px var(--primary-color, #03a9f4);
          border-radius: 8px;
        }nhl-live-game-card .live-expand-strip {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 11px;
          margin: 2px 0 0;
          color: var(--secondary-text-color);
        }nhl-live-game-card .live-expandable.expanded .live-expand-strip {
          height: 9px;
          margin-bottom: -2px;
          opacity: 0.55;
        }nhl-live-game-card .live-expandable:hover .live-expand-strip {
          color: var(--primary-text-color);
          opacity: 1;
        }nhl-live-game-card .upcoming-expandable {
          cursor: pointer;
          outline: none;
        }nhl-live-game-card .upcoming-expandable:focus-visible {
          box-shadow: 0 0 0 2px var(--primary-color, #03a9f4);
          border-radius: 8px;
        }nhl-live-game-card .upcoming-details-panel {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px 6px 4px;
          margin-top: 6px;
          border-top: 1px solid var(--divider-color, rgba(127,127,127,0.25));
        }nhl-live-game-card .upcoming-details-panel > :first-child {
          margin-top: 0;
          padding-top: 0;
          border-top: none;
        }nhl-live-game-card .upcoming-goalies-grid {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 8px;
        }nhl-live-game-card .upcoming-goalie-side {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          text-align: center;
        }nhl-live-game-card .upcoming-goalie-side.align-right {  }nhl-live-game-card .upcoming-goalie-img {

          width: clamp(44px, 16cqi, 144px);
          aspect-ratio: 1 / 1;
          border-radius: 50%;
          object-fit: cover;
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
        }nhl-live-game-card .upcoming-goalie-img.logo-fallback {
          object-fit: contain;
          padding: 4px;
        }nhl-live-game-card .upcoming-goalie-img.placeholder {
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
        }nhl-live-game-card .wrapper.headshot-size-small .player-shot,
nhl-live-game-card .wrapper.headshot-size-small .upcoming-goalie-img {
          width: 40px;
        }nhl-live-game-card .wrapper.headshot-size-medium .player-shot,
nhl-live-game-card .wrapper.headshot-size-medium .upcoming-goalie-img {
          width: 56px;
        }nhl-live-game-card .wrapper.headshot-size-large .player-shot,
nhl-live-game-card .wrapper.headshot-size-large .upcoming-goalie-img {
          width: 72px;
        }nhl-live-game-card .wrapper.headshot-size-xlarge .player-shot,
nhl-live-game-card .wrapper.headshot-size-xlarge .upcoming-goalie-img {
          width: 88px;
        }nhl-live-game-card .upcoming-goalie-name {
          font-weight: 600;
          font-size: 0.92em;
          line-height: 1.1;
          color: var(--warning-color);
        }nhl-live-game-card .upcoming-goalie-stat {
          font-size: 0.85em;
          opacity: 0.9;
        }nhl-live-game-card .upcoming-goalie-stat.secondary {
          opacity: 0.75;
        }nhl-live-game-card .upcoming-goalies-vs {
          font-size: 0.8em;
          opacity: 0.6;
          font-style: italic;
        }nhl-live-game-card .panel-heading {
          font-size: 0.78em;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          text-align: center;
          opacity: 0.85;
          margin-bottom: 4px;
        }nhl-live-game-card .decisions-panel {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }nhl-live-game-card .decisions-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
          gap: 10px;
          align-items: start;
        }nhl-live-game-card .decision-cell {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          min-width: 0;
          text-align: center;
        }nhl-live-game-card .decision-img {

          width: clamp(44px, 11cqi, 88px);
          aspect-ratio: 1 / 1;
          border-radius: 50%;
          object-fit: cover;
          background: rgba(255,255,255,0.04);
        }nhl-live-game-card .decision-img.placeholder {
          background: rgba(255,255,255,0.06);
        }nhl-live-game-card .decision-label {
          font-size: 0.72em;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--secondary-text-color);
        }nhl-live-game-card .decision-name {
          font-size: 0.92em;
          line-height: 1.2;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }nhl-live-game-card .decision-record {
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
          font-weight: 500;
          margin-left: 2px;
        }nhl-live-game-card .decision-stats {
          font-size: 0.8em;
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
          font-weight: 500;
          line-height: 1.25;
          margin-top: 2px;
          overflow-wrap: anywhere;
        }nhl-live-game-card .scoring-plays-panel {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }nhl-live-game-card .scoring-play-row {
          display: grid;
          grid-template-columns: 28px 38px 1fr max-content;
          gap: 6px;

          align-items: start;
          padding: 2px 4px;
          font-size: 0.86em;
          line-height: 1.3;
        }nhl-live-game-card .scoring-play-period {
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
          font-weight: 600;
        }nhl-live-game-card .scoring-play-team {
          color: var(--secondary-text-color);
          font-weight: 600;
          letter-spacing: 0.02em;
        }nhl-live-game-card .scoring-play-text {

          min-width: 0;
          white-space: normal;
          overflow-wrap: anywhere;
        }nhl-live-game-card .scoring-play-score {
          font-variant-numeric: tabular-nums;
          color: var(--secondary-text-color);
        }nhl-live-game-card .leader-empty {
          color: var(--secondary-text-color);
          opacity: 0.6;
        }nhl-live-game-card .final-highlights-row {
          display: flex;
          justify-content: center;
          margin: 4px 0 2px;
        }nhl-live-game-card .final-highlights-link {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: var(--primary-text-color);
          text-decoration: none;
          font-size: 0.88em;
          line-height: 1.2;
          transition: background 0.12s ease;
        }nhl-live-game-card .final-highlights-link:hover,
nhl-live-game-card .final-highlights-link:focus {
          background: rgba(255, 255, 255, 0.12);
          text-decoration: none;
          outline: none;
        }nhl-live-game-card .final-highlights-icon {
          color: var(--primary-color, #03a9f4);
          font-size: 0.85em;
        }nhl-live-game-card .final-highlights-label {
          font-weight: 500;
        }nhl-live-game-card .upcoming-standings {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }nhl-live-game-card .standings-heading {
          font-size: 0.95em;
          font-weight: 600;
          text-align: center;
          opacity: 0.85;
          margin-bottom: 4px;
        }nhl-live-game-card .standings-row {
          display: grid;
          grid-template-columns: 1fr 56px 48px;
          align-items: center;
          gap: 6px;
          padding: 2px 4px;
          font-size: 0.88em;
          line-height: 1.25;
          border-radius: 4px;
        }nhl-live-game-card .standings-row.standings-header {
          font-size: 0.75em;
          font-weight: 600;
          opacity: 0.65;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }nhl-live-game-card .standings-row.my-team {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
          font-weight: 600;
        }nhl-live-game-card .standings-name {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }nhl-live-game-card .standings-wl {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }nhl-live-game-card .standings-gb {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
nhl-live-game-card .nhl-score-values { display: grid; grid-template-columns: 14px 32px; column-gap: 7px; }
nhl-live-game-card .nhl-power-play { color: var(--warning-color, #ffb300); font-size: 0.66em; font-weight: 700; }
nhl-live-game-card .nhl-strength-space { width: 14px; }
nhl-live-game-card .nhl-period-stack { gap: 4px; min-width: 40px; }
nhl-live-game-card .nhl-clock { font-size: 0.78em; line-height: 1; white-space: nowrap; font-variant-numeric: tabular-nums; }
nhl-live-game-card .nhl-situation { font-size: 0.9em; gap: 6px; }
nhl-live-game-card .matchup-grid.enhanced.nhl-matchup { grid-template-columns: minmax(0,1fr) clamp(70px,24cqi,140px) minmax(0,1fr); align-items: center; }
nhl-live-game-card .matchup-grid.enhanced.nhl-matchup.nhl-no-rink { grid-template-columns: repeat(2,minmax(0,1fr)); }
nhl-live-game-card .nhl-rink-center { width: 100%; min-width: 0; align-self: center; }
nhl-live-game-card .nhl-rink-center svg, nhl-live-game-card .nhl-shot-chart svg { display: block; width: 100%; height: auto; }
nhl-live-game-card .nhl-rink-outline { fill: rgba(125,185,215,.09); stroke: rgba(160,190,210,.7); stroke-width: 1.5; }
nhl-live-game-card .nhl-rink-blue { stroke: #5894e0; stroke-width: 1.6; }
nhl-live-game-card .nhl-rink-red { stroke: #dc6666; stroke-width: 1.2; fill: none; }
nhl-live-game-card .nhl-rink-circle { fill: none; stroke: #dc6666; stroke-width: .8; }
nhl-live-game-card .nhl-rink-crease { fill: rgba(80,155,235,.25); stroke: #dc6666; stroke-width: .7; }
nhl-live-game-card .nhl-rink-play { fill: #63a2ff; stroke: var(--primary-text-color,#fff); stroke-width: .7; opacity: .8; }
nhl-live-game-card .nhl-rink-play.home { fill: #e89554; }
nhl-live-game-card .nhl-rink-play.unknown { fill: var(--secondary-text-color,#9b9b9b); }
nhl-live-game-card .nhl-rink-play.goal { stroke: var(--warning-color,#ffb300); stroke-width: 1.5; opacity: 1; }
nhl-live-game-card .nhl-shot-away { color: #63a2ff; }
nhl-live-game-card .nhl-shot-home { color: #e89554; }
nhl-live-game-card .nhl-rink-label { fill: var(--secondary-text-color,#9b9b9b); font-size: 5px; font-weight: 600; }
nhl-live-game-card .nhl-rink-only { max-width: 160px; margin: 12px auto; }
nhl-live-game-card .nhl-shot-chart { margin: 10px 0 0; padding: 8px 0 0; border-top: 1px solid var(--divider-color,rgba(127,127,127,.2)); }
nhl-live-game-card .nhl-chart-caption { text-align: center; color: var(--secondary-text-color); font-size: .7em; margin-top: 2px; }
nhl-live-game-card .nhl-goalie-context, nhl-live-game-card .nhl-leader-category { font-size: .72em; color: var(--secondary-text-color); margin-top: 3px; }
nhl-live-game-card .nhl-period-summary { white-space: normal; flex-wrap: wrap; text-align: right; }
nhl-live-game-card .nhl-strength { grid-template-columns: minmax(0,1fr) max-content minmax(0,1fr); column-gap: 6px; font-size: .82em; }
nhl-live-game-card .nhl-strength .base-slot { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
nhl-live-game-card .nhl-strength .base-slot:last-child { justify-content: flex-end; }
nhl-live-game-card .nhl-strength-label { text-align: center; color: var(--secondary-text-color); }
nhl-live-game-card .nhl-empty-net { color: var(--warning-color,#ffb300); font-weight: 600; }
nhl-live-game-card .nhl-play-clock { color: var(--secondary-text-color); font-size: .75em; white-space: nowrap; margin-right: 4px; }
nhl-live-game-card .nhl-history-label { text-align: center; color: var(--info-color,#4a90d9); font-size: .85em; margin-bottom: 6px; }
nhl-live-game-card .standings-row { grid-template-columns: minmax(0,1fr) 65px 48px; }
nhl-live-game-card .leader-item { grid-template-columns: max-content minmax(0,1fr); gap: 1px 6px; }
nhl-live-game-card .leader-val { grid-column: 1 / -1; white-space: normal; overflow-wrap: anywhere; }
nhl-live-game-card .matchup-copy.centered-copy { width: 100%; max-width: 100%; min-width: 0; }
nhl-live-game-card .matchup-side .stat-line { white-space: normal; overflow-wrap: anywhere; text-overflow: clip; }

`;


function ensureCardStyles(host) {
  if (host.querySelector("." + CARD_STYLE_ID)) return;
  const style = document.createElement("style");
  style.className = CARD_STYLE_ID;
  style.textContent = CARD_CSS;
  host.appendChild(style);
}
if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, NhlLiveGameCard);
