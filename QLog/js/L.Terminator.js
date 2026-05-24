(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('leaflet')) :
	typeof define === 'function' && define.amd ? define(['leaflet'], factory) :
	(global = typeof globalThis !== 'undefined' ? globalThis : global || self, (global.L = global.L || {}, global.L.terminator = factory(global.L)));
})(this, (function (L) { 'use strict';

	/* Terminator.js -- Overlay twilight terminators on a Leaflet map */

	var R2D = 180 / Math.PI;
	var D2R = Math.PI / 180;
	var MAX_RESOLUTION = 10;
	var MAX_LONGITUDE_RANGE = 1440;

	function julian(date) {
		/* Calculate the present UTC Julian Date. Function is valid after
		 * the beginning of the UNIX epoch 1970-01-01 and ignores leap
		 * seconds. */
		return (date / 86400000) + 2440587.5;
	}

	function GMST(julianDay) {
		/* Calculate Greenwich Mean Sidereal Time according to
			 http://aa.usno.navy.mil/faq/docs/GAST.php */
		var d = julianDay - 2451545.0;
		// Low precision equation is good enough for our purposes.
		return (18.697374558 + 24.06570982441908 * d) % 24;
	}

	var DEFAULT_TERMINATORS = [
		{
			name: 'civil',
			solarDepression: 6,
			stroke: false,
			fillColor: '#9a9a9a',
			fillOpacity: 0.20
		},
		{
			name: 'nautical',
			solarDepression: 12,
			stroke: false,
			fillColor: '#777',
			fillOpacity: 0.24
		},
		{
			name: 'astronomical',
			solarDepression: 18,
			stroke: false,
			fillColor: '#555',
			fillOpacity: 0.28
		}
	];

	function normalizeLongitude(lng) {
		while (lng < -180) {
			lng += 360;
		}
		while (lng >= 180) {
			lng -= 360;
		}
		return lng;
	}

	function unwrapLongitude(lng, previousLng) {
		if (previousLng === null) {
			return lng;
		}
		while (lng - previousLng > 180) {
			lng -= 360;
		}
		while (lng - previousLng < -180) {
			lng += 360;
		}
		return lng;
	}

	function sunEclipticPosition(julianDay) {
		/* Compute the position of the Sun in ecliptic coordinates at
			 julianDay.  Following
			 http://en.wikipedia.org/wiki/Position_of_the_Sun */
		// Days since start of J2000.0
		var n = julianDay - 2451545.0;
		// mean longitude of the Sun
		var L = 280.460 + 0.9856474 * n;
		L %= 360;
		// mean anomaly of the Sun
		var g = 357.528 + 0.9856003 * n;
		g %= 360;
		// ecliptic longitude of Sun
		var lambda = L + 1.915 * Math.sin(g * D2R) +
			0.02 * Math.sin(2 * g * D2R);
		// distance from Sun in AU
		var R = 1.00014 - 0.01671 * Math.cos(g * D2R) -
			0.0014 * Math.cos(2 * g * D2R);
		return {lambda: lambda, R: R};
	}

	function eclipticObliquity(julianDay) {
		// Following the short term expression in
		// http://en.wikipedia.org/wiki/Axial_tilt#Obliquity_of_the_ecliptic_.28Earth.27s_axial_tilt.29
		var n = julianDay - 2451545.0;
		// Julian centuries since J2000.0
		var T = n / 36525;
		var epsilon = 23.43929111 -
			T * (46.836769 / 3600
				- T * (0.0001831 / 3600
					+ T * (0.00200340 / 3600
						- T * (0.576e-6 / 3600
							- T * 4.34e-8 / 3600))));
		return epsilon;
	}

	function sunEquatorialPosition(sunEclLng, eclObliq) {
		/* Compute the Sun's equatorial position from its ecliptic
		 * position. Inputs are expected in degrees. Outputs are in
		 * degrees as well. */
		var alpha = Math.atan(Math.cos(eclObliq * D2R)
			* Math.tan(sunEclLng * D2R)) * R2D;
		var delta = Math.asin(Math.sin(eclObliq * D2R)
			* Math.sin(sunEclLng * D2R)) * R2D;

		var lQuadrant = Math.floor(sunEclLng / 90) * 90;
		var raQuadrant = Math.floor(alpha / 90) * 90;
		alpha = alpha + (lQuadrant - raQuadrant);

		return {alpha: alpha, delta: delta};
	}

	function solarContext(time) {
		var today = time ? new Date(time) : new Date();
		var julianDay = julian(today);
		var sunEclPos = sunEclipticPosition(julianDay);
		var eclObliq = eclipticObliquity(julianDay);

		return {
			gst: GMST(julianDay),
			sunEqPos: sunEquatorialPosition(sunEclPos.lambda, eclObliq)
		};
	}

	function positiveNumber(value, fallback) {
		value = Number(value);
		return isFinite(value) && value > 0 ? value : fallback;
	}

	function positiveClampedNumber(value, fallback, max) {
		return Math.min(positiveNumber(value, fallback), max);
	}

	function clampNumber(value, min, max, fallback) {
		value = Number(value);
		if (!isFinite(value)) {
			return fallback;
		}

		return Math.min(max, Math.max(min, value));
	}

	var Terminator = L.LayerGroup.extend({
		options: {
			interactive: false,
			stroke: false,
			fillColor: '#777',
			fillOpacity: 0.24,
			resolution: 2,
			longitudeRange: 720,
			solarDepression: 6
		},

		initialize: function (options) {
			this.version = '0.1.0';
			this._polygons = [];
			this._boundaries = [];
			L.Util.setOptions(this, options);
			this.options.resolution = positiveClampedNumber(this.options.resolution, 2, MAX_RESOLUTION);
			this.options.longitudeRange = positiveClampedNumber(
				this.options.longitudeRange,
				720,
				MAX_LONGITUDE_RANGE
			);
			this.options.solarDepression = clampNumber(this.options.solarDepression, 0, 90, 6);
			L.LayerGroup.prototype.initialize.call(this, []);
			if (!this.options.deferRender) {
				this.setTime(this.options.time);
			}
		},

		setTime: function (date) {
			this.options.time = date;
			return this.setSolarContext(solarContext(date));
		},

		setSolarContext: function (context) {
			this._solarContext = context;
			this._render(context);
			return this;
		},

		setStyle: function (style) {
			L.Util.extend(this.options, style);
			if (this._solarContext) {
				this._render(this._solarContext);
			}
			return this;
		},

		_subSolarPoint: function (sunPos, gst) {
			return {
				lat: sunPos.delta,
				lng: normalizeLongitude(sunPos.alpha - gst * 15)
			};
		},

		_computeTwilightBoundary: function (sunPos, gst) {
			var subSolarPoint = this._subSolarPoint(sunPos, gst);
			var antiSolarPoint = {
				lat: -subSolarPoint.lat,
				lng: normalizeLongitude(subSolarPoint.lng + 180)
			};
			var lat1 = antiSolarPoint.lat * D2R;
			var lng1 = antiSolarPoint.lng * D2R;
			var angularDistance = Math.max(
				0,
				90 - this.options.solarDepression
			) * D2R;
			var sinLat1 = Math.sin(lat1);
			var cosLat1 = Math.cos(lat1);
			var sinDistance = Math.sin(angularDistance);
			var cosDistance = Math.cos(angularDistance);
			var points = [];
			var previousLng = null;

			for (var i = 0; i <= 360 * this.options.resolution; i++) {
				var bearing = i / this.options.resolution * D2R;
				var lat = Math.asin(
					sinLat1 * cosDistance +
					cosLat1 * sinDistance * Math.cos(bearing));
				var lng = lng1 + Math.atan2(
					Math.sin(bearing) * sinDistance * cosLat1,
					cosDistance - sinLat1 * Math.sin(lat));

				lng = unwrapLongitude(normalizeLongitude(lng * R2D), previousLng);
				previousLng = lng;
				points.push([lat * R2D, lng]);
			}

			return points;
		},

		_applyLongitudeRange: function (points) {
			var minLng = -this.options.longitudeRange / 2;
			var maxLng = this.options.longitudeRange / 2;
			var bounds = this._ringBounds(points);
			var rangedPoints = [];
			var firstOffset = Math.floor((minLng - bounds.maxLng) / 360) * 360;
			var lastOffset = Math.ceil((maxLng - bounds.minLng) / 360) * 360;

			for (var offset = firstOffset; offset <= lastOffset; offset += 360) {
				var segmentMinLng = bounds.minLng + offset;
				var segmentMaxLng = bounds.maxLng + offset;

				if (segmentMaxLng >= minLng && segmentMinLng <= maxLng) {
					var segment = [];
					for (var i = 0; i < points.length; i++) {
						segment.push([points[i][0], points[i][1] + offset]);
					}
					rangedPoints.push(segment);
				}
			}

			return rangedPoints;
		},

		_compute: function (context) {
			this._lastSunDeclination = context.sunEqPos.delta;
			return this._applyLongitudeRange(
				this._computeTwilightBoundary(context.sunEqPos, context.gst)
			);
		},

		_render: function (context) {
			var rings = this._compute(context);
			var fillOptions = this._fillOptions();
			var boundaryOptions = this._boundaryOptions();

			for (var i = 0; i < rings.length; i++) {
				var latLngs = this._filledRings(rings[i]);

				if (this._polygons[i]) {
					this._polygons[i].setLatLngs(latLngs);
					this._polygons[i].setStyle(fillOptions);
				} else {
					this._polygons[i] = L.polygon(latLngs, fillOptions);
					this.addLayer(this._polygons[i]);
				}

				if (boundaryOptions) {
					if (this._boundaries[i]) {
						this._boundaries[i].setLatLngs(rings[i]);
						this._boundaries[i].setStyle(boundaryOptions);
					} else {
						this._boundaries[i] = L.polyline(rings[i], boundaryOptions);
						this.addLayer(this._boundaries[i]);
					}
				} else if (this._boundaries[i]) {
					this.removeLayer(this._boundaries[i]);
					this._boundaries[i] = null;
				}
			}

			for (var j = rings.length; j < this._polygons.length; j++) {
				this.removeLayer(this._polygons[j]);
				if (this._boundaries[j]) {
					this.removeLayer(this._boundaries[j]);
				}
			}

			this._polygons.length = rings.length;
			this._boundaries.length = rings.length;
		},

		_fillOptions: function () {
			return L.Util.extend({}, this.options, {
				stroke: false
			});
		},

		_boundaryOptions: function () {
			if (this.options.stroke === false) {
				return null;
			}

			return L.Util.extend({}, this.options, {
				fill: false
			});
		},

		redraw: function () {
			this.eachLayer(function (layer) {
				if (layer.redraw) {
					layer.redraw();
				}
			});
			return this;
		},

		_filledRings: function (ring) {
			var bounds = this._ringBounds(ring);
			var filledRings = [
				this._outerRing(bounds),
				ring
			];

			if (!this._isPoleDark(90)) {
				filledRings.push([
					[bounds.maxLat, bounds.minLng],
					[bounds.maxLat, bounds.maxLng],
					[90, bounds.maxLng],
					[90, bounds.minLng]
				]);
			}

			if (!this._isPoleDark(-90)) {
				filledRings.push([
					[-90, bounds.minLng],
					[-90, bounds.maxLng],
					[bounds.minLat, bounds.maxLng],
					[bounds.minLat, bounds.minLng]
				]);
			}

			return filledRings;
		},

		_outerRing: function (bounds) {
			return [
				[-90, bounds.minLng],
				[-90, bounds.maxLng],
				[90, bounds.maxLng],
				[90, bounds.minLng]
			];
		},

		_ringBounds: function (ring) {
			var minLat = ring[0][0];
			var maxLat = ring[0][0];
			var minLng = ring[0][1];
			var maxLng = ring[0][1];

			for (var i = 1; i < ring.length; i++) {
				minLat = Math.min(minLat, ring[i][0]);
				maxLat = Math.max(maxLat, ring[i][0]);
				minLng = Math.min(minLng, ring[i][1]);
				maxLng = Math.max(maxLng, ring[i][1]);
			}

			return {
				minLat: minLat,
				maxLat: maxLat,
				minLng: minLng,
				maxLng: maxLng
			};
		},

		_isPoleDark: function (lat) {
			if (lat > 0) {
				return this._lastSunDeclination <= -this.options.solarDepression;
			}

			return this._lastSunDeclination >= this.options.solarDepression;
		}
	});

	var TwilightTerminator = L.LayerGroup.extend({
		options: {
			interactive: false,
			resolution: 2,
			longitudeRange: 720,
			terminators: DEFAULT_TERMINATORS
		},

		initialize: function (options) {
			this._userOptions = options || {};
			L.Util.setOptions(this, options);
			L.LayerGroup.prototype.initialize.call(this, []);
			this._terminatorLayers = {};
			this._initTerminators();
			this.setTime(this.options.time);
		},

		setTime: function (date) {
			this.options.time = date;
			var context = solarContext(date);
			this.eachLayer(function (layer) {
				layer.setSolarContext(context);
			});
			return this;
		},

		setStyle: function (style) {
			L.Util.extend(this.options, style);
			this.eachLayer(function (layer) {
				layer.setStyle(style);
			});
			return this;
		},

		redraw: function () {
			this.eachLayer(function (layer) {
				if (layer.redraw) {
					layer.redraw();
				}
			});
			return this;
		},

		getTerminator: function (name) {
			return this._terminatorLayers[name];
		},

		_initTerminators: function () {
			var baseOptions = L.Util.extend({}, this.options);
			delete baseOptions.terminators;
			baseOptions.deferRender = true;
			var sharedStyleOptions = this._sharedStyleOptions();

			for (var i = 0; i < this.options.terminators.length; i++) {
				var definition = this.options.terminators[i];
				var layerOptions = L.Util.extend({}, baseOptions, definition, sharedStyleOptions);
				var layer = new Terminator(layerOptions);

				if (definition.name) {
					this._terminatorLayers[definition.name] = layer;
				}

				this.addLayer(layer);
			}
		},

		_sharedStyleOptions: function () {
			var options = L.Util.extend({}, this._userOptions);
			delete options.terminators;
			delete options.time;
			delete options.resolution;
			delete options.longitudeRange;
			delete options.solarDepression;
			delete options.name;
			return options;
		}
	});

	function terminator(options) {
		return new TwilightTerminator(options);
	}

	terminator.julian = julian;
	terminator.GMST = GMST;
	terminator.Terminator = Terminator;
	terminator.TwilightTerminator = TwilightTerminator;

	return terminator;

}));
