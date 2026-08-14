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

    initApp: function () {
      if (this.regions.length) {
        this.activeRegion = this.regions[0].slug;
      }
      this.loopsMap = new window.LoopsMap("loops-map");
      this.loopsMap.renderRegion(this.currentRegion);
    },

    get currentRegion() {
      var self = this;
      return (
        this.regions.find(function (r) { return r.slug === self.activeRegion; }) ||
        this.regions[0] ||
        { name: "", locations: [], blurb: "" }
      );
    },

    get eligible() {
      var self = this;
      return this.submissions
        .filter(function (s) { return s.region === self.activeRegion && !s.funRun; })
        .sort(rankSort);
    },

    get funRuns() {
      var self = this;
      return this.submissions
        .filter(function (s) { return s.region === self.activeRegion && s.funRun; })
        .sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
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

    openSubmission: function (sub) {
      this.selected = sub;
      this.modalOpen = true;
      var self = this;
      this.$nextTick(function () {
        if (!self.subMap) self.subMap = new window.SubmissionMap("submission-map");
        self.subMap.render(sub, self.currentRegion);
      });
    },

    closeModal: function () {
      this.modalOpen = false;
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

    funRunPillText: function (sub) {
      if (!sub.funRun) return "Eligible";
      if (sub.funRunReason === "no-time") return "Fun run · untimed";
      if (sub.funRunReason === "reroute") return "Fun run · rerouted";
      return "Fun run";
    },

    withBase: function (url) {
      if (!url) return "";
      if (/^https?:\/\//.test(url)) return url;
      return (window.SITE_BASEURL || "") + url;
    }
  };
}
