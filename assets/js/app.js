/* Alpine component that ties the region selector, map, and leaderboard together.
   Registered as a global so x-data="scoopApp()" can find it. */

function scoopApp() {
  "use strict";

  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function readJson(id) {
    var el = document.getElementById(id);
    if (!el) return [];
    try { return JSON.parse(el.textContent); } catch (e) { return []; }
  }

  // Fastest finish first; missing times sort last; ties broken by date.
  function rankSort(a, b) {
    var da = typeof a.durationMinutes === "number" ? a.durationMinutes : Infinity;
    var db = typeof b.durationMinutes === "number" ? b.durationMinutes : Infinity;
    if (da !== db) return da - db;
    return String(a.date || "").localeCompare(String(b.date || ""));
  }

  return {
    regions: readJson("loops-data"),
    submissions: readJson("submissions-data"),
    activeRegion: null,
    loopsMap: null,
    subMap: null,
    modalOpen: false,
    selected: null,
    shareCopied: false,

    // One ranked board per loop type, per region.
    boards: [
      { type: "five", label: "Five Scoop Loop", note: "All five designated shops." },
      { type: "three", label: "Three Scoop Loop", note: "Any three of the region's shops." }
    ],

    initApp: function () {
      if (this.regions.length) {
        this.activeRegion = this.regions[0].slug;
      }
      this.loopsMap = new window.LoopsMap("loops-map");
      this.loopsMap.renderRegion(this.currentRegion);

      // Deep links: /#/sub/<id> opens that entry, and back/forward work.
      var self = this;
      window.addEventListener("hashchange", function () { self.syncFromHash(); });
      window.addEventListener("popstate", function () { self.syncFromHash(); });
      this.syncFromHash();
    },

    get currentRegion() {
      var self = this;
      return (
        this.regions.find(function (r) { return r.slug === self.activeRegion; }) ||
        this.regions[0] ||
        { name: "", locations: [], blurb: "" }
      );
    },

    // Ranked entries for the active region and a given loop type ("five"/"three").
    boardFor: function (type) {
      var self = this;
      return this.submissions
        .filter(function (s) {
          return s.region === self.activeRegion && (s.loopType || "five") === type;
        })
        .sort(rankSort);
    },

    loopTypeLabel: function (sub) {
      return (sub && sub.loopType === "three") ? "Three Scoop Loop" : "Five Scoop Loop";
    },

    setRegion: function (slug) {
      this.activeRegion = slug;
      this.loopsMap.renderRegion(this.currentRegion);
    },

    focusShop: function (loc) {
      this.loopsMap.focusLocation(loc);
      // Nudge the map into view on small screens.
      document.getElementById("loops-map").scrollIntoView({ behavior: "smooth", block: "nearest" });
    },

    // ---------- modal + deep-link routing ----------
    // The URL hash is kept in sync with the open entry. openSubmission/closeModal
    // update the hash; syncFromHash applies whatever the hash says (on load,
    // hashchange, and back/forward).
    parseHash: function () {
      var m = (window.location.hash || "").match(/^#\/sub\/(.+)$/);
      return m ? decodeURIComponent(m[1]) : null;
    },

    syncFromHash: function () {
      var id = this.parseHash();
      if (id) {
        var sub = this.submissions.find(function (s) { return s.id === id; });
        if (sub) { this.applyOpen(sub); return; }
      }
      if (this.modalOpen) this.modalOpen = false;
    },

    applyOpen: function (sub) {
      // Make sure the modal's context (region map, leaderboard) matches the entry.
      if (sub.region && sub.region !== this.activeRegion) {
        this.activeRegion = sub.region;
        this.loopsMap.renderRegion(this.currentRegion);
      }
      this.selected = sub;
      this.modalOpen = true;
      this.shareCopied = false;
      var self = this;
      this.$nextTick(function () {
        if (!self.subMap) self.subMap = new window.SubmissionMap("submission-map");
        self.subMap.render(sub, self.currentRegion);
      });
    },

    openSubmission: function (sub) {
      this.applyOpen(sub);
      var target = "#/sub/" + encodeURIComponent(sub.id);
      if (window.location.hash !== target) {
        history.pushState(null, "", target);
      }
    },

    closeModal: function () {
      this.modalOpen = false;
      // Drop the #/sub/... hash without adding a history entry or reloading.
      if (this.parseHash()) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    },

    shareUrl: function (sub) {
      return window.location.origin + window.location.pathname + "#/sub/" + encodeURIComponent(sub.id);
    },

    copyShareLink: function () {
      if (!this.selected) return;
      var url = this.shareUrl(this.selected);
      var self = this;
      var done = function () {
        self.shareCopied = true;
        setTimeout(function () { self.shareCopied = false; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(function () { self.copyFallback(url, done); });
      } else {
        this.copyFallback(url, done);
      }
    },

    copyFallback: function (text, done) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* no-op */ }
      document.body.removeChild(ta);
    },

    // ---------- formatters ----------
    todayHours: function (loc) {
      if (!loc.hours) return "Hours not listed";
      var name = WEEKDAYS[new Date().getDay()];
      return loc.hours[name] || "Closed";
    },

    formatDate: function (iso) {
      if (!iso) return "—";
      var d = new Date(iso + "T00:00:00");
      if (isNaN(d)) return iso;
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    },

    formatDuration: function (min) {
      if (typeof min !== "number" || isNaN(min)) return "—";
      var h = Math.floor(min / 60);
      var m = Math.round(min % 60);
      if (h === 0) return m + "m";
      return h + "h " + (m < 10 ? "0" + m : m) + "m";
    },

    medal: function (i) {
      return ["🥇", "🥈", "🥉"][i] || String(i + 1);
    },

    // Normalized list of photos for an entry (supports the older single-photo
    // shape too, just in case).
    photoList: function (sub) {
      if (!sub) return [];
      if (Array.isArray(sub.photos)) return sub.photos.filter(function (p) { return p && p.src; });
      if (sub.photoUrl) return [{ src: sub.photoUrl, alt: sub.photoAlt }];
      return [];
    },

    // Normalized list of evidence embeds (tolerates the older single-object shape).
    evidenceList: function (sub) {
      if (!sub) return [];
      var e = sub.evidence;
      if (Array.isArray(e)) return e.filter(Boolean);
      if (e && e.url) return [e];
      return [];
    },

    // Iframely's extracted caption text (Instagram, etc.) collapses the
    // original line breaks into runs of spaces: a run of 3+ reads as a
    // paragraph break, exactly 2 as a single line break. Restore both so the
    // caption renders as it was written instead of one run-on line. Paired
    // with `white-space: pre-line` on .evidence-card__title, which turns
    // these \n's into visible breaks without disabling word wrap.
    formatEvidenceTitle: function (title) {
      if (!title) return "";
      return String(title).replace(/ {3,}/g, "\n\n").replace(/ {2}/g, "\n");
    },

    // The activity can be Strava, Garmin, Nike Run Club, and so on.
    activityProvider: function (url) {
      if (!url) return "";
      if (/strava\./i.test(url)) return "Strava";
      if (/garmin|connect\.garmin/i.test(url)) return "Garmin";
      if (/nike/i.test(url)) return "Nike Run Club";
      if (/runkeeper/i.test(url)) return "Runkeeper";
      if (/mapmyrun|mapmyfitness/i.test(url)) return "MapMyRun";
      if (/komoot/i.test(url)) return "komoot";
      if (/coros/i.test(url)) return "COROS";
      if (/suunto/i.test(url)) return "Suunto";
      return "";
    },

    activityLinkText: function (url) {
      var provider = this.activityProvider(url);
      return provider ? "View on " + provider : "Open activity";
    },

    withBase: function (url) {
      if (!url) return "";
      if (/^https?:\/\//.test(url)) return url;
      return (window.SITE_BASEURL || "") + url;
    }
  };
}
