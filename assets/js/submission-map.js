/* The per-submission map shown in the detail modal:
   the runner's simplified route overlaid on the loop's shop pins.
   Depends on Leaflet (L) and helpers from loops-map.js. */

(function () {
  "use strict";

  window.SubmissionMap = function (elementId) {
    this.elementId = elementId;
    this.map = null;
    this.layer = null;
  };

  window.SubmissionMap.prototype.render = function (sub, region) {
    if (!this.map) {
      this.map = L.map(this.elementId, { scrollWheelZoom: false });
      L.tileLayer(window.SCOOP_TILE.url, window.SCOOP_TILE.options).addTo(this.map);
      var m = this.map;
      this.map.on("focus", function () { m.scrollWheelZoom.enable(); });
      this.map.on("blur", function () { m.scrollWheelZoom.disable(); });
    }

    if (this.layer) { this.map.removeLayer(this.layer); }
    this.layer = L.layerGroup().addTo(this.map);

    // Shop pins for context (unnumbered; the route itself shows the path taken).
    (region.locations || []).forEach(function (loc) {
      L.marker([loc.coordinates.lat, loc.coordinates.lon], {
        icon: window.scoopIcon(true),
        title: loc.name,
        alt: loc.name
      }).addTo(this.layer);
    }, this);

    // The route polyline.
    var routeBounds = null;
    if (sub.routeGeoJSON) {
      var route = L.geoJSON(sub.routeGeoJSON, {
        style: { color: "#0f766e", weight: 4, opacity: 0.95 }
      }).addTo(this.layer);
      routeBounds = route.getBounds();
    }

    var bounds =
      routeBounds && routeBounds.isValid()
        ? routeBounds
        : L.latLngBounds(
            (region.locations || []).map(function (l) {
              return [l.coordinates.lat, l.coordinates.lon];
            })
          );

    if (bounds && bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.15));
    }

    var mapRef = this.map;
    // The modal animates in, so recalc size once it is on screen.
    setTimeout(function () { mapRef.invalidateSize(); }, 80);
  };
})();
