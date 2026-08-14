/* Shared Leaflet helpers + the region overview map.
   Depends on Leaflet (loaded globally as L). */

(function () {
  "use strict";

  // CARTO Voyager tiles over OpenStreetMap data.
  window.SCOOP_TILE = {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 20,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  window.escapeHtml = escapeHtml;

  // Unnumbered scoop marker (a dot) as a DivIcon. Shops have no set order, so
  // the marker deliberately implies no sequence.
  window.scoopIcon = function (small) {
    var size = small ? 14 : 18;
    return L.divIcon({
      className: "scoop-pin" + (small ? " scoop-pin--sm" : ""),
      html: '<span class="scoop-pin__inner"></span>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -(size / 2) - 2]
    });
  };

  function hoursHtml(hours) {
    if (!hours) return "";
    var rows = Object.keys(hours)
      .map(function (day) {
        return (
          '<div class="popup-hours__row"><span>' +
          escapeHtml(day) +
          "</span><span>" +
          escapeHtml(hours[day]) +
          "</span></div>"
        );
      })
      .join("");
    return '<div class="popup-hours">' + rows + "</div>";
  }

  window.shopPopupHtml = function (loc) {
    return (
      '<p class="popup-name">' +
      escapeHtml(loc.name) +
      "</p>" +
      '<p class="popup-line">' +
      escapeHtml(loc.address) +
      "</p>" +
      (loc.seasonal ? '<p class="popup-line"><em>Seasonal hours</em></p>' : "") +
      hoursHtml(loc.hours)
    );
  };

  // ------- Region overview map -------
  window.LoopsMap = function (elementId) {
    this.map = L.map(elementId, { scrollWheelZoom: false });
    L.tileLayer(window.SCOOP_TILE.url, window.SCOOP_TILE.options).addTo(this.map);

    // Only grab the scroll wheel while the map has focus, so the page still scrolls.
    var self = this;
    this.map.on("focus", function () { self.map.scrollWheelZoom.enable(); });
    this.map.on("blur", function () { self.map.scrollWheelZoom.disable(); });

    this.layer = L.layerGroup().addTo(this.map);
    this.markers = {};
  };

  window.LoopsMap.prototype.renderRegion = function (region) {
    this.layer.clearLayers();
    this.markers = {};
    var pts = [];
    var self = this;

    (region.locations || []).forEach(function (loc) {
      var latlng = [loc.coordinates.lat, loc.coordinates.lon];
      pts.push(latlng);
      var marker = L.marker(latlng, {
        icon: window.scoopIcon(),
        keyboard: true,
        title: loc.name,
        alt: loc.name
      });
      marker.bindPopup(window.shopPopupHtml(loc));
      marker.addTo(self.layer);
      self.markers[loc.id] = marker;
    });

    if (pts.length) {
      this.map.fitBounds(L.latLngBounds(pts).pad(0.2));
    }
    var m = this.map;
    setTimeout(function () { m.invalidateSize(); }, 60);
  };

  window.LoopsMap.prototype.focusLocation = function (loc) {
    var marker = this.markers[loc.id];
    if (marker) {
      this.map.setView(marker.getLatLng(), 15, { animate: true });
      marker.openPopup();
    }
  };
})();
