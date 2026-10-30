// WrenchVision 2D diagram upgrades — plug-in, DOM-only.
//
// Hooks the existing photo-diagram render (app.js renderManual) via a
// MutationObserver on #diagramBox. The working loop is untouched:
// this file only reads what renderManual already put in the DOM
// (plus one inert data attribute per marker, data-du-mask, set by
// app.js from the server's photoRegions) and adds presentation.
//
// What it adds, when a photo diagram is on screen:
//   1. Part-name labels beside each marker, taken from the callout
//      list renderManual already wrote (#callouts li, same order as
//      the marker numbers). No text is invented: a marker with no
//      matching callout entry gets no label.
//   2. Leader lines from each marker badge to its own label chip,
//      drawn in a fixed viewport SVG and redrawn on scroll/resize.
//      Both ends sit on the photo, so no line ever leaves the
//      diagram or crosses the caption and steps below it.
//   3. Tap-to-zoom: tapping a marker opens a full-screen view of
//      that marker's region of the photo; tapping anywhere, the
//      close button, or Escape returns to the full view.
//   4. Part-shaped mask outlines: when a marker carries a valid
//      SAM mask (data-du-mask), the gold box border is replaced
//      by an outline traced from the model's own mask raster —
//      the actual part shape, not a rectangle. The badge, label,
//      leader line, and zoom target stay exactly where they were.
//
// Mask decoding — verified, not guessed:
//   The mask wire format is Meta's SAM 3 protocol
//   (github.com/meta-models/meta-sam, protocol/sam3.md), and the
//   decoder below is a port of Meta's meta-sam-parser reference
//   (mask token data=H,W,payload; payload marker ~ = lossless,
//   the API default, or ! = one_bit; base85 body with a 5-digit
//   length prefix and an arithmetic-coded body). It was verified
//   against the reference decoder on a live SAM 3.1 response:
//   the same payload decodes to the same raster byte for byte.
//   Nothing here draws a shape the model did not return.
//
// Fallbacks, all automatic:
//   - Schematic diagram (no .photo-diagram): the plug-in does
//     nothing; the schematic renders exactly as before.
//   - No photo (page reload): same — nothing added.
//   - No mask, or a mask that fails any check: that marker keeps
//     its honest gold box; other markers are unaffected.
//   - No matching callout text: marker keeps its number badge only.
//   - Any plug-in error: caught and logged; the base render is
//     never disturbed, because the plug-in only ever adds nodes.

(function () {
  "use strict";

  var diagramBox = document.getElementById("diagramBox");
  var calloutsEl = document.getElementById("callouts");
  if (!diagramBox || !calloutsEl) return;

  var LEADER_SVG_ID = "du-leaders";
  var OUTLINE_SVG_ID = "du-outlines";
  var zoomOverlay = null;
  var zoomedNum = 0;

  // ---- SAM mask codec (port of Meta's meta_sam_parser) ----
  // Wire data value: "H,W,payload". H,W are the mask raster size,
  // which equals the box interior (x2-x1+1, y2-y1+1). Payload:
  // first char ~ (lossless) or ! (one_bit), then a base85 body:
  // 5-digit length prefix + arithmetic-coded bytes, packed 4
  // bytes to 5 digits. Raster is row-major bytes of 0/1.
  // Anything malformed throws; callers treat that as "no mask"
  // and keep the box. No shape is ever invented.
  var MASK_ALPHABET = "!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{";
  var MASK_VALUES = [];
  (function () {
    var i;
    for (i = 0; i < 128; i++) MASK_VALUES[i] = -1;
    for (i = 0; i < MASK_ALPHABET.length; i++) {
      MASK_VALUES[MASK_ALPHABET.charCodeAt(i)] = i;
    }
  })();

  function maskDigit(ch) {
    var code = ch.charCodeAt(0);
    var v = code < 128 ? MASK_VALUES[code] : -1;
    if (v < 0 || v >= 85) throw new Error("bad mask character");
    return v;
  }

  function maskUnpack(body) {
    if (body.length < 5) throw new Error("short mask");
    var length = 0;
    var i;
    for (i = 0; i < 5; i++) length = length * 85 + maskDigit(body.charAt(i));
    var remainder = length % 4;
    var expected = 5 + Math.floor(length / 4) * 5 + (remainder === 0 ? 0 : remainder + 1);
    if (body.length !== expected) throw new Error("mask length mismatch");
    var out = new Uint8Array(length);
    var src = 5;
    var dst = 0;
    var full = length - remainder;
    var value;
    var k;
    while (dst < full) {
      value = 0;
      for (k = 0; k < 5; k++) value = value * 85 + maskDigit(body.charAt(src + k));
      if (value > 4294967295) throw new Error("mask group out of range");
      src += 5;
      out[dst] = (value >>> 24) & 255;
      out[dst + 1] = (value >>> 16) & 255;
      out[dst + 2] = (value >>> 8) & 255;
      out[dst + 3] = value & 255;
      dst += 4;
    }
    if (remainder > 0) {
      value = 0;
      for (k = 0; k < 5; k++) {
        value = value * 85 + (k < remainder + 1 ? maskDigit(body.charAt(src + k)) : 84);
      }
      if (value > 4294967295) throw new Error("mask tail out of range");
      for (k = 0; k < remainder; k++) {
        out[dst + k] = (value >>> (24 - k * 8)) & 255;
      }
    }
    return out;
  }

  function maskPack(input) {
    var length = input.length;
    var rem = length;
    var prefix = ["", "", "", "", ""];
    var i;
    for (i = 4; i >= 0; i--) {
      prefix[i] = MASK_ALPHABET.charAt(rem % 85);
      rem = Math.floor(rem / 85);
    }
    if (rem !== 0) throw new Error("mask too large");
    var out = prefix.join("");
    var offset = 0;
    var full = length - (length % 4);
    var value;
    var digits;
    var k;
    var d;
    while (offset < full) {
      value = ((input[offset] << 24) | (input[offset + 1] << 16) | (input[offset + 2] << 8) | input[offset + 3]) >>> 0;
      digits = [0, 0, 0, 0, 0];
      for (k = 4; k >= 0; k--) {
        digits[k] = value % 85;
        value = Math.floor((value - digits[k]) / 85);
      }
      for (d = 0; d < 5; d++) out += MASK_ALPHABET.charAt(digits[d]);
      offset += 4;
    }
    var tail = length - offset;
    if (tail > 0) {
      value = 0;
      for (k = 0; k < 4; k++) {
        value = (((value << 8) | (k < tail ? input[offset + k] : 0)) >>> 0);
      }
      digits = [0, 0, 0, 0, 0];
      for (k = 4; k >= 0; k--) {
        digits[k] = value % 85;
        value = Math.floor((value - digits[k]) / 85);
      }
      for (d = 0; d < tail + 1; d++) out += MASK_ALPHABET.charAt(digits[d]);
    }
    return out;
  }

  function RangeDecoder(input) {
    if (input.length < 4) throw new Error("mask missing finalization");
    this.input = input;
    this.pos = 0;
    this.low = 0;
    this.range = 4294967295;
    this.code = 0;
    this.scaled = 0;
    var i;
    for (i = 0; i < 4; i++) {
      this.code = (((this.code << 8) | this.read()) >>> 0);
    }
  }
  RangeDecoder.prototype.read = function () {
    if (this.pos >= this.input.length) throw new Error("mask ended early");
    return this.input[this.pos++];
  };
  RangeDecoder.prototype.frequency = function (total) {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) throw new Error("mask coding state");
    var value = Math.floor(((this.code - this.low) >>> 0) / this.scaled);
    return value >= total ? total - 1 : value;
  };
  RangeDecoder.prototype.decode = function (cumulative, frequency) {
    this.low = (this.low + this.scaled * cumulative) >>> 0;
    this.range = this.scaled * frequency;
    for (;;) {
      var top = ((this.low ^ ((this.low + this.range) >>> 0)) >>> 0);
      if (top < 16777216) {
        // Top bytes agree: shift.
      } else if (this.range < 65536) {
        this.range = (((-this.low) >>> 0) & 65535);
      } else {
        break;
      }
      this.code = (((this.code << 8) | this.read()) >>> 0);
      this.low = ((this.low << 8) >>> 0);
      this.range = ((this.range << 8) >>> 0);
    }
  };

  function RangeEncoder() {
    this.low = 0;
    this.range = 4294967295;
    this.output = [];
  }
  RangeEncoder.prototype.encode = function (cumulative, frequency, total) {
    var scaled = Math.floor(this.range / total);
    this.low = (this.low + scaled * cumulative) >>> 0;
    this.range = scaled * frequency;
    for (;;) {
      var top = ((this.low ^ ((this.low + this.range) >>> 0)) >>> 0);
      if (top < 16777216) {
        // Shift.
      } else if (this.range < 65536) {
        this.range = (((-this.low) >>> 0) & 65535);
      } else {
        break;
      }
      this.output.push((this.low >>> 24) & 255);
      this.low = ((this.low << 8) >>> 0);
      this.range = ((this.range << 8) >>> 0);
    }
  };
  RangeEncoder.prototype.finish = function () {
    var i;
    for (i = 0; i < 4; i++) {
      this.output.push((this.low >>> 24) & 255);
      this.low = ((this.low << 8) >>> 0);
    }
    return this.output;
  };

  function oneBitContextAt(padded, position, prior, earlier) {
    return (
      padded[position - 1] |
      (padded[position - 2] << 1) |
      (padded[prior - 2] << 2) |
      (padded[prior - 1] << 3) |
      (padded[prior] << 4) |
      (padded[prior + 1] << 5) |
      (padded[prior + 2] << 6) |
      (padded[earlier - 2] << 7) |
      (padded[earlier - 1] << 8) |
      (padded[earlier] << 9) |
      (padded[earlier + 1] << 10) |
      (padded[earlier + 2] << 11)
    );
  }

  function oneBitUpdateCounts(counts, offset, bit) {
    counts[offset + bit] = (counts[offset + bit] + 14) & 65535;
    if (counts[offset] + counts[offset + 1] >= 4096) {
      counts[offset] = (counts[offset] >> 1) || 1;
      counts[offset + 1] = (counts[offset + 1] >> 1) || 1;
    }
  }

  function decodeOneBitRaster(payload, width, height) {
    var decoder = new RangeDecoder(maskUnpack(payload.slice(1)));
    var counts = new Uint16Array(4096 * 2);
    var i;
    for (i = 0; i < counts.length; i++) counts[i] = 1;
    var paddedWidth = width + 4;
    var padded = new Uint8Array(paddedWidth * (height + 2));
    var output = new Uint8Array(width * height);
    var y;
    var x;
    for (y = 0; y < height; y++) {
      var row = (y + 2) * paddedWidth + 2;
      for (x = 0; x < width; x++) {
        var position = row + x;
        var context = oneBitContextAt(padded, position, position - paddedWidth, position - 2 * paddedWidth);
        var offset = context << 1;
        var zero = counts[offset];
        var one = counts[offset + 1];
        var value = decoder.frequency(zero + one);
        var bit = value < zero ? 0 : 1;
        if (bit === 0) {
          decoder.decode(0, zero);
        } else {
          decoder.decode(zero, one);
        }
        padded[position] = bit;
        output[y * width + x] = bit;
        oneBitUpdateCounts(counts, offset, bit);
      }
    }
    return output;
  }

  function encodeOneBitRaster(input, width, height) {
    var encoder = new RangeEncoder();
    var counts = new Uint16Array(4096 * 2);
    var i;
    for (i = 0; i < counts.length; i++) counts[i] = 1;
    var paddedWidth = width + 4;
    var padded = new Uint8Array(paddedWidth * (height + 2));
    var y;
    var x;
    for (y = 0; y < height; y++) {
      var row = (y + 2) * paddedWidth + 2;
      for (x = 0; x < width; x++) {
        var position = row + x;
        var context = oneBitContextAt(padded, position, position - paddedWidth, position - 2 * paddedWidth);
        var offset = context << 1;
        var zero = counts[offset];
        var one = counts[offset + 1];
        var bit = input[y * width + x];
        if (bit !== 0 && bit !== 1) throw new Error("mask is not binary");
        if (bit === 0) {
          encoder.encode(0, zero, zero + one);
        } else {
          encoder.encode(zero, one, zero + one);
        }
        padded[position] = bit;
        oneBitUpdateCounts(counts, offset, bit);
      }
    }
    return "!" + maskPack(encoder.finish());
  }

  function paethPredict(left, up, upperLeft) {
    var estimate = left + up - upperLeft;
    var ld = Math.abs(estimate - left);
    var ud = Math.abs(estimate - up);
    var uld = Math.abs(estimate - upperLeft);
    if (ld <= ud && ld <= uld) return left;
    return ud <= uld ? up : upperLeft;
  }

  function losslessPredictByte(output, offset, x, y, mode, width) {
    if (mode < 0 || mode >= 5) throw new Error("bad lossless predictor");
    var left = x > 0 ? output[offset - 1] : 0;
    var up = y > 0 ? output[offset - width] : 0;
    if (mode === 1) return up;
    if (mode === 2) return left;
    if (mode === 3) return (left + up) >> 1;
    var upperLeft = x > 0 && y > 0 ? output[offset - width - 1] : 0;
    if (mode === 0) return paethPredict(left, up, upperLeft);
    if (upperLeft >= Math.max(left, up)) return Math.min(left, up);
    if (upperLeft <= Math.min(left, up)) return Math.max(left, up);
    return left + up - upperLeft;
  }

  function losslessZeroContext(residuals, offset, x, y, width) {
    var left = x > 0 ? (residuals[offset - 1] === 0 ? 1 : 0) : 1;
    var up = y > 0 ? (residuals[offset - width] === 0 ? 1 : 0) : 1;
    var upperLeft = x > 0 && y > 0 ? (residuals[offset - width - 1] === 0 ? 1 : 0) : 1;
    var upperRight = y > 0 && x < width - 1 ? (residuals[offset - width + 1] === 0 ? 1 : 0) : 1;
    return left | (up << 1) | (upperLeft << 2) | (upperRight << 3);
  }

  function decodeLosslessCoverage(payload, width, height) {
    if (payload.charAt(0) !== "~") throw new Error("lossless marker");
    var packed = maskUnpack(payload.slice(1));
    if (packed.length < 5) throw new Error("lossless truncated");
    var selector = packed[0];
    var decoder = new RangeDecoder(packed.subarray(1));
    var length = width * height;
    var output = new Uint8Array(length);
    var residuals = new Uint8Array(length);
    var zeroCounts = new Uint32Array(32);
    var i;
    for (i = 0; i < 32; i++) zeroCounts[i] = 1;
    var orderOne = new Uint16Array(256 * 256);
    for (i = 0; i < orderOne.length; i++) orderOne[i] = 1;
    var orderOneTotals = new Int32Array(256);
    for (i = 0; i < 256; i++) orderOneTotals[i] = 256;
    var orderZero = new Uint16Array(256);
    for (i = 0; i < 256; i++) orderZero[i] = 2;
    var orderZeroTotal = 512;
    var orderTwo = {};
    var previous = 0;
    var offset;
    for (offset = 0; offset < length; offset++) {
      var x = offset % width;
      var y = Math.floor(offset / width);
      var zeroOffset = losslessZeroContext(residuals, offset, x, y, width) << 1;
      var zero = zeroCounts[zeroOffset];
      var nonzero = zeroCounts[zeroOffset + 1];
      var zeroFrequency = decoder.frequency(zero + nonzero);
      var bit = zeroFrequency < zero ? 0 : 1;
      if (bit === 0) {
        decoder.decode(0, zero);
      } else {
        decoder.decode(zero, nonzero);
      }
      zeroCounts[zeroOffset + bit] = (zeroCounts[zeroOffset + bit] + 32) >>> 0;
      if (zeroCounts[zeroOffset] + zeroCounts[zeroOffset + 1] >= 16384) {
        zeroCounts[zeroOffset] = (zeroCounts[zeroOffset] >> 1) || 1;
        zeroCounts[zeroOffset + 1] = (zeroCounts[zeroOffset + 1] >> 1) || 1;
      }
      var symbol = 0;
      if (bit === 1) {
        var above = offset >= width ? residuals[offset - width] : 0;
        var key = (previous << 8) | above;
        var second = orderTwo[key];
        if (!second) {
          second = new Uint16Array(257);
          orderTwo[key] = second;
        }
        var firstOffset = previous << 8;
        var excludedZero = second[0] + orderOne[firstOffset] + orderZero[0];
        var total = second[256] + orderOneTotals[previous] + orderZeroTotal - excludedZero;
        var target = decoder.frequency(total);
        var cumulative = 0;
        symbol = 1;
        var frequency = second[1] + orderOne[firstOffset + 1] + orderZero[1];
        while (cumulative + frequency <= target) {
          cumulative += frequency;
          symbol += 1;
          if (symbol >= 256) throw new Error("lossless malformed");
          frequency = second[symbol] + orderOne[firstOffset + symbol] + orderZero[symbol];
        }
        decoder.decode(cumulative, frequency);
        second[symbol] = (second[symbol] + 616) & 65535;
        second[256] = (second[256] + 616) & 65535;
        if (second[256] >= 50176) {
          var scaledTotal = 0;
          var v;
          for (v = 0; v < 256; v++) {
            second[v] = second[v] >> 1;
            scaledTotal += second[v];
          }
          second[256] = scaledTotal & 65535;
        }
        orderOne[firstOffset + symbol] = (orderOne[firstOffset + symbol] + 56) & 65535;
        orderOneTotals[previous] = (orderOneTotals[previous] + 56) | 0;
        if (orderOneTotals[previous] >= 8192) {
          var totalAfter = 0;
          for (v = 0; v < 256; v++) {
            var scaled = (orderOne[firstOffset + v] >> 1) || 1;
            orderOne[firstOffset + v] = scaled;
            totalAfter += scaled;
          }
          orderOneTotals[previous] = totalAfter | 0;
        }
        orderZero[symbol] = (orderZero[symbol] + 32) & 65535;
        orderZeroTotal += 32;
        if (orderZeroTotal >= 4096) {
          var totalAfterZero = 0;
          for (v = 0; v < 256; v++) {
            orderZero[v] = orderZero[v] >> 1;
            totalAfterZero += orderZero[v];
          }
          orderZeroTotal = totalAfterZero;
        }
      }
      residuals[offset] = symbol;
      var prediction = losslessPredictByte(output, offset, x, y, selector, width);
      var delta = symbol & 1 ? -((symbol + 1) >> 1) : symbol >> 1;
      output[offset] = (prediction + delta) & 255;
      previous = symbol;
    }
    return output;
  }

  // Decode a mask token data value ("H,W,payload") to a binary
  // raster, or null when anything fails. The raster is row-major
  // bytes of 0/1, exactly W*H long.
  function decodeMaskRaster(dataString) {
    try {
      if (typeof dataString !== "string") return null;
      var c1 = dataString.indexOf(",");
      var c2 = c1 === -1 ? -1 : dataString.indexOf(",", c1 + 1);
      if (c1 <= 0 || c2 <= c1) return null;
      var hText = dataString.slice(0, c1);
      var wText = dataString.slice(c1 + 1, c2);
      if (!/^\d+$/.test(hText) || !/^\d+$/.test(wText)) return null;
      var height = parseInt(hText, 10);
      var width = parseInt(wText, 10);
      var payload = dataString.slice(c2 + 1);
      if (!(height > 0 && width > 0) || width * height > 4000000) return null;
      if (payload.charAt(0) === "~") {
        var coverage = decodeLosslessCoverage(payload, width, height);
        var out = new Uint8Array(width * height);
        var i;
        for (i = 0; i < coverage.length; i++) {
          out[i] = coverage[i] >= 129 ? 1 : 0;
        }
        return { width: width, height: height, raster: out };
      }
      if (payload.charAt(0) === "!") {
        var raster = decodeOneBitRaster(payload, width, height);
        // Canonical check, like the reference: a one_bit
        // payload that does not re-encode exactly is rejected.
        if (encodeOneBitRaster(raster, width, height) !== payload) return null;
        return { width: width, height: height, raster: raster };
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  // Trace a binary raster to SVG subpaths in mask coordinates
  // (marching squares, ported from the reference tracer). Cell
  // (row, col) is centered on (col, row), so edges sit at
  // half-pixel offsets. Returns "" for an empty mask.
  function rasterToMaskPaths(raster, width, height) {
    function px(row, col) {
      if (row < 0 || row >= height || col < 0 || col >= width) return 0;
      return raster[row * width + col];
    }
    var segments = [];
    var row;
    var col;
    for (row = 0; row <= height; row++) {
      for (col = 0; col <= width; col++) {
        var tl = px(row - 1, col - 1);
        var tr = px(row - 1, col);
        var br = px(row, col);
        var bl = px(row, col - 1);
        var ci = (tl << 3) | (tr << 2) | (br << 1) | bl;
        if (ci === 0 || ci === 15) continue;
        var top = [col - 0.5, row - 1];
        var bottom = [col - 0.5, row];
        var left = [col - 1, row - 0.5];
        var right = [col, row - 0.5];
        if (ci === 1 || ci === 14) {
          segments.push([left, bottom]);
        } else if (ci === 2 || ci === 13) {
          segments.push([bottom, right]);
        } else if (ci === 3 || ci === 12) {
          segments.push([left, right]);
        } else if (ci === 4 || ci === 11) {
          segments.push([top, right]);
        } else if (ci === 5) {
          segments.push([left, top]);
          segments.push([bottom, right]);
        } else if (ci === 6 || ci === 9) {
          segments.push([top, bottom]);
        } else if (ci === 7 || ci === 8) {
          segments.push([left, top]);
        } else if (ci === 10) {
          segments.push([top, right]);
          segments.push([left, bottom]);
        }
      }
    }
    if (!segments.length) return "";
    var adjacency = {};
    var order = [];
    function keyOf(p) {
      return p[0] + "," + p[1];
    }
    function add(p, q) {
      var k = keyOf(p);
      if (!adjacency[k]) {
        adjacency[k] = [];
        order.push(p);
      }
      adjacency[k].push(q);
    }
    var s;
    for (s = 0; s < segments.length; s++) {
      add(segments[s][0], segments[s][1]);
      add(segments[s][1], segments[s][0]);
    }
    var paths = [];
    var oi;
    for (oi = 0; oi < order.length; oi++) {
      var start = order[oi];
      var startKey = keyOf(start);
      if (!adjacency[startKey]) continue;
      var path = [];
      var current = start;
      var previous = null;
      var visited = {};
      for (;;) {
        path.push(current);
        var curKey = keyOf(current);
        var neighbors = adjacency[curKey];
        if (!neighbors) break;
        var next = null;
        var ni;
        for (ni = 0; ni < neighbors.length; ni++) {
          if (!previous || keyOf(neighbors[ni]) !== keyOf(previous)) {
            next = neighbors[ni];
            break;
          }
        }
        if (next === null) break;
        var filtered = [];
        for (ni = 0; ni < neighbors.length; ni++) {
          if (keyOf(neighbors[ni]) !== keyOf(next)) filtered.push(neighbors[ni]);
        }
        if (filtered.length) {
          adjacency[curKey] = filtered;
        } else {
          delete adjacency[curKey];
        }
        var nextKey = keyOf(next);
        var nextNeighbors = adjacency[nextKey];
        if (nextNeighbors) {
          var nextFiltered = [];
          for (ni = 0; ni < nextNeighbors.length; ni++) {
            if (keyOf(nextNeighbors[ni]) !== curKey) nextFiltered.push(nextNeighbors[ni]);
          }
          if (nextFiltered.length) {
            adjacency[nextKey] = nextFiltered;
          } else {
            delete adjacency[nextKey];
          }
        }
        if (keyOf(next) === startKey) break;
        visited[keyOf(current)] = true;
        previous = current;
        current = next;
      }
      if (path.length >= 3) paths.push(path);
    }
    function num(v) {
      return v === Math.floor(v) ? String(v) : String(Math.round(v * 1000) / 1000);
    }
    var out = [];
    var pi;
    var qi;
    for (pi = 0; pi < paths.length; pi++) {
      var parts = ["M" + num(paths[pi][0][0]) + " " + num(paths[pi][0][1])];
      for (qi = 1; qi < paths[pi].length; qi++) {
        parts.push("L" + num(paths[pi][qi][0]) + " " + num(paths[pi][qi][1]));
      }
      parts.push("Z");
      out.push(parts.join(""));
    }
    return out.join("");
  }

  // Map mask-coordinate path points into the photo's percent
  // space, using the marker box's own rect (left/top/width/
  // height in percent, as app.js wrote them). A mask point
  // (mx, my) sits in cell-centered coords: cell (row, col)
  // spans [col-0.5, col+0.5], so +0.5 aligns the left/top
  // cell edges with the box edges.
  function maskPathToPercent(maskPath, boxLeft, boxTop, boxWidth, boxHeight, maskW, maskH) {
    function fmt(v) {
      var r = Math.round(v * 1000) / 1000;
      return String(r);
    }
    return maskPath.replace(/([ML])(-?[\d.]+)\s+(-?[\d.]+)/g, function (whole, cmd, xs, ys) {
      var mx = parseFloat(xs);
      var my = parseFloat(ys);
      var px = boxLeft + ((mx + 0.5) * boxWidth) / maskW;
      var py = boxTop + ((my + 0.5) * boxHeight) / maskH;
      return cmd + fmt(px) + " " + fmt(py);
    });
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // 1-based marker number -> callout text, or "" when there is no
  // matching entry. Marker numbers are calloutIndex + 1, in the
  // same order as the #callouts list.
  function calloutText(num) {
    var items = calloutsEl.querySelectorAll("li");
    if (num >= 1 && num <= items.length) {
      return items[num - 1].textContent.trim();
    }
    return "";
  }

  function removeLeaders() {
    var svg = document.getElementById(LEADER_SVG_ID);
    if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
  }

  function clearCalloutHighlight() {
    var items = calloutsEl.querySelectorAll(".du-callout-active");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove("du-callout-active");
    }
  }

  function closeZoom() {
    if (zoomOverlay && zoomOverlay.parentNode) {
      zoomOverlay.parentNode.removeChild(zoomOverlay);
    }
    zoomOverlay = null;
    zoomedNum = 0;
    clearCalloutHighlight();
    var svg = document.getElementById(LEADER_SVG_ID);
    if (svg) svg.style.display = "";
    document.body.style.overflow = "";
  }

  // Full cleanup before every re-enhance: leaders live in <body>,
  // so a diagram re-render must remove them explicitly (labels
  // live inside the old diagram node and go away with it).
  function cleanup() {
    removeLeaders();
    if (zoomOverlay) closeZoom();
  }

  // Position one label chip beside its marker, entirely inside the
  // photo. Tries right, left, below, above, in that order, and
  // clamps into the photo as a last resort. Labels live in the
  // wrap (the positioned ancestor), never in the box: the old code
  // appended them to the box but positioned them in wrap
  // coordinates, which double-counted the box offset and shoved
  // right-edge labels off the photo.
  function placeLabel(wrap, box, label) {
    var wr = wrap.getBoundingClientRect();
    var br = box.getBoundingClientRect();
    var bx = br.left - wr.left;
    var by = br.top - wr.top;
    var lw = label.offsetWidth || 0;
    var lh = label.offsetHeight || 0;
    var GAP = 6;
    var spots = [
      { left: bx + br.width + GAP, top: by },
      { left: bx - lw - GAP, top: by },
      { left: bx, top: by + br.height + GAP },
      { left: bx, top: by - lh - GAP },
    ];
    var pick = null;
    for (var s = 0; s < spots.length; s++) {
      var sp = spots[s];
      if (
        sp.left >= 0 &&
        sp.top >= 0 &&
        sp.left + lw <= wr.width &&
        sp.top + lh <= wr.height
      ) {
        pick = sp;
        break;
      }
    }
    if (!pick) {
      // Nothing fits cleanly: clamp the first choice (right of the
      // box) inside the photo rather than letting it clip.
      pick = {
        left: Math.max(0, Math.min(spots[0].left, wr.width - lw)),
        top: Math.max(0, Math.min(spots[0].top, wr.height - lh)),
      };
    }
    label.style.left = pick.left + "px";
    label.style.top = pick.top + "px";
    label.style.visibility = "visible";
  }

  // Recompute every label position from current layout (resize,
  // orientation change), then redraw the leaders to match.
  function repositionLabels() {
    try {
      var wrap = diagramBox.querySelector(".photo-diagram");
      if (!wrap) return;
      var boxes = wrap.querySelectorAll(".photo-box");
      for (var i = 0; i < boxes.length; i++) {
        var num = boxes[i].dataset.duNum;
        if (!num) continue;
        var label = wrap.querySelector(
          ".du-label[data-du-num=\"" + num + "\"]"
        );
        if (label) placeLabel(wrap, boxes[i], label);
      }
      drawLeaders();
    } catch (err) {
      if (window.console) console.warn("diagram-upgrades: reposition failed", err);
    }
  }

  function drawLeaders() {
    try {
      removeLeaders();
      if (zoomOverlay) return;
      var wrap = diagramBox.querySelector(".photo-diagram");
      if (!wrap) return;
      var svgNS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("id", LEADER_SVG_ID);
      var boxes = wrap.querySelectorAll(".photo-box");
      var drawn = 0;
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        var badge = box.querySelector(".photo-num");
        var num = box.dataset.duNum
          ? parseInt(box.dataset.duNum, 10)
          : NaN;
        if (!badge || !num) continue;
        // The label chip is the line's other end: both ends sit on
        // the photo, so the segment never leaves the diagram.
        var label = wrap.querySelector(
          ".du-label[data-du-num=\"" + num + "\"]"
        );
        if (!label) continue;
        var from = badge.getBoundingClientRect();
        var to = label.getBoundingClientRect();
        if (!from.width && !from.height) continue;
        if (!to.width && !to.height) continue;
        var bx = from.left + from.width / 2;
        var by = from.top + from.height / 2;
        // Aim at the midpoint of the label edge facing the badge.
        var tx, ty;
        if (to.left >= from.left + from.width) {
          tx = to.left;
          ty = to.top + to.height / 2;
        } else if (to.left + to.width <= from.left) {
          tx = to.left + to.width;
          ty = to.top + to.height / 2;
        } else if (to.top >= from.top + from.height) {
          tx = to.left + to.width / 2;
          ty = to.top;
        } else {
          tx = to.left + to.width / 2;
          ty = to.top + to.height;
        }
        var line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", bx);
        line.setAttribute("y1", by);
        line.setAttribute("x2", tx);
        line.setAttribute("y2", ty);
        line.setAttribute("data-du-num", String(num));
        if (num === zoomedNum) line.setAttribute("class", "du-leader-active");
        svg.appendChild(line);
        drawn++;
      }
      if (drawn) document.body.appendChild(svg);
    } catch (err) {
      if (window.console) console.warn("diagram-upgrades: leaders failed", err);
    }
  }

  function openZoom(box, num, text) {
    try {
      var wrap = diagramBox.querySelector(".photo-diagram");
      var img = wrap ? wrap.querySelector("img") : null;
      if (!img || !img.src) return;
      var imgRect = img.getBoundingClientRect();
      var boxRect = box.getBoundingClientRect();
      if (!imgRect.width || !imgRect.height || !boxRect.width || !boxRect.height) {
        return; // Not laid out yet — never zoom blind.
      }
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var scale = Math.min(
        (0.88 * vw) / boxRect.width,
        (0.78 * vh) / boxRect.height
      );
      if (!(scale > 0)) return;
      // Box center, in the photo image's own displayed coordinates.
      var bx = (boxRect.left - imgRect.left) + boxRect.width / 2;
      var by = (boxRect.top - imgRect.top) + boxRect.height / 2;
      var tx = vw / 2 - imgRect.left - bx * scale;
      var ty = vh / 2 - imgRect.top - by * scale;

      closeZoom();
      var overlay = document.createElement("div");
      overlay.className = "du-zoom";
      var zoomImg = document.createElement("img");
      zoomImg.src = img.src;
      zoomImg.alt = text ? "Zoomed view: " + text : "Zoomed view of the marked part";
      zoomImg.style.width = imgRect.width + "px";
      zoomImg.style.height = imgRect.height + "px";
      zoomImg.style.left = imgRect.left + "px";
      zoomImg.style.top = imgRect.top + "px";
      zoomImg.style.transform =
        "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
      overlay.appendChild(zoomImg);
      if (text) {
        var cap = document.createElement("div");
        cap.className = "du-zoom-caption";
        cap.textContent = text;
        overlay.appendChild(cap);
      }
      var closeBtn = document.createElement("button");
      closeBtn.className = "du-zoom-close";
      closeBtn.type = "button";
      closeBtn.textContent = "X";
      closeBtn.setAttribute("aria-label", "Close zoomed view");
      closeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        closeZoom();
        drawLeaders();
      });
      overlay.appendChild(closeBtn);
      overlay.addEventListener("click", function () {
        closeZoom();
        drawLeaders();
      });
      document.body.appendChild(overlay);
      document.body.style.overflow = "hidden";
      zoomOverlay = overlay;
      zoomedNum = num;
      var items = calloutsEl.querySelectorAll("li");
      if (num >= 1 && num <= items.length) {
        items[num - 1].classList.add("du-callout-active");
      }
      var svg = document.getElementById(LEADER_SVG_ID);
      if (svg) svg.style.display = "none";
    } catch (err) {
      if (window.console) console.warn("diagram-upgrades: zoom failed", err);
    }
  }

  function enhance() {
    try {
      cleanup();
      var wrap = diagramBox.querySelector(".photo-diagram");
      if (!wrap) return; // Schematic or empty: leave exactly as before.
      var boxes = wrap.querySelectorAll(".photo-box");
      if (!boxes.length) return;
      wrap.classList.add("du-enhanced");
      // Labels live in the wrap now: drop any from a previous
      // enhance (and their flags) so positions are recomputed
      // fresh instead of stacking or going stale.
      var oldLabels = wrap.querySelectorAll(".du-label");
      for (var li = 0; li < oldLabels.length; li++) {
        if (oldLabels[li].parentNode) {
          oldLabels[li].parentNode.removeChild(oldLabels[li]);
        }
      }
      for (var bi = 0; bi < boxes.length; bi++) {
        delete boxes[bi].dataset.duLabeled;
      }
      // Rebuild the outline overlay from scratch each time, so a
      // re-render can never stack two copies of it.
      var oldOverlay = wrap.querySelector("#" + OUTLINE_SVG_ID);
      if (oldOverlay && oldOverlay.parentNode) {
        oldOverlay.parentNode.removeChild(oldOverlay);
      }
      // Outlines rebuild from scratch with the overlay, so a
      // re-enhance of the same boxes must not skip them.
      var wasOutlined = wrap.querySelectorAll(".du-outlined");
      var oi;
      for (oi = 0; oi < wasOutlined.length; oi++) {
        wasOutlined[oi].classList.remove("du-outlined");
      }
      var outlineSvg = null;
      function outlineSvgFor() {
        if (outlineSvg) return outlineSvg;
        var svgNS = "http://www.w3.org/2000/svg";
        outlineSvg = document.createElementNS(svgNS, "svg");
        outlineSvg.setAttribute("id", OUTLINE_SVG_ID);
        outlineSvg.setAttribute("viewBox", "0 0 100 100");
        outlineSvg.setAttribute("preserveAspectRatio", "none");
        wrap.appendChild(outlineSvg);
        return outlineSvg;
      }
      for (var i = 0; i < boxes.length; i++) {
        (function (box) {
          var badge = box.querySelector(".photo-num");
          var num = badge ? parseInt(badge.textContent, 10) : NaN;
          if (!num) return;
          box.dataset.duNum = String(num);
          if (!box.dataset.duBound) {
            box.dataset.duBound = "1";
            box.addEventListener("click", function () {
              openZoom(box, num, calloutText(num));
            });
          }
          if (!box.dataset.duLabeled) {
            var text = calloutText(num);
            if (text) {
              box.dataset.duLabeled = "1";
              var label = document.createElement("span");
              label.className = "du-label";
              label.textContent = text;
              label.dataset.duNum = String(num);
              wrap.appendChild(label);
              placeLabel(wrap, box, label);
            }
          }
          // Part-shaped outline, in place of (not on top of) the
          // box border. Any failure keeps the honest box.
          if (box.dataset.duMask) {
            var decoded = decodeMaskRaster(box.dataset.duMask);
            if (decoded) {
              var maskPath = rasterToMaskPaths(decoded.raster, decoded.width, decoded.height);
              if (maskPath) {
                var bl = parseFloat(box.style.left) || 0;
                var bt = parseFloat(box.style.top) || 0;
                var bw = parseFloat(box.style.width) || 0;
                var bh = parseFloat(box.style.height) || 0;
                if (bw > 0 && bh > 0) {
                  var pctPath = maskPathToPercent(maskPath, bl, bt, bw, bh, decoded.width, decoded.height);
                  var svgNS2 = "http://www.w3.org/2000/svg";
                  var pathEl = document.createElementNS(svgNS2, "path");
                  pathEl.setAttribute("d", pctPath);
                  pathEl.setAttribute("data-du-num", String(num));
                  outlineSvgFor().appendChild(pathEl);
                  box.classList.add("du-outlined");
                }
              }
            }
          }
        })(boxes[i]);
      }
      drawLeaders();
    } catch (err) {
      if (window.console) console.warn("diagram-upgrades: enhance failed", err);
    }
  }

  var observer = new MutationObserver(function () {
    enhance();
  });
  observer.observe(diagramBox, { childList: true });

  var redrawSoon = debounce(repositionLabels, 120);
  window.addEventListener("resize", redrawSoon);
  window.addEventListener("scroll", redrawSoon, true);
  window.addEventListener("orientationchange", redrawSoon);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && zoomOverlay) {
      closeZoom();
      drawLeaders();
    }
  });

  enhance();

  // Test seam only: lets a scratch test drive the plug-in without a
  // browser tap. Not used by the app itself.
  window.WrenchVisionDiagramUpgrades = {
    enhanceNow: enhance,
    redrawLeaders: drawLeaders,
    repositionLabels: repositionLabels,
    closeZoom: closeZoom,
    decodeMaskForTest: decodeMaskRaster,
    maskPathForTest: rasterToMaskPaths,
  };
})();
