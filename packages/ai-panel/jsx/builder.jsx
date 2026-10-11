// F2A builder — ExtendScript (ES3). Builds an Illustrator document from an F2A-IR JSON file.
// Entry point: f2aBuild(pathToJson) -> JSON string { ok, created, warnings, error }.
// f2aConvert(json) converts colors with Illustrator's color settings for the plugin preview.

$.evalFile(new File($.fileName).parent.fsName + '/bleed.jsx');

var F2A = (function () {
  var KAPPA = 0.5522847498;
  var EPS = 1e-6;

  var doc, opts, assetDir, warnings, created, dx, dy, fontIndex, metricsCache, firstArtboard, pageFill;

  // ---------- utils ----------

  function warn(msg) {
    warnings.push(msg);
  }

  function readJSON(path) {
    var f = new File(path);
    f.encoding = 'UTF-8';
    if (!f.open('r')) throw new Error('Cannot open ' + path);
    var s = f.read();
    f.close();
    return eval('(' + s + ')');
  }

  function quote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n|\r/g, '\\n') + '"';
  }

  function toJSON(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return quote(v);
    var parts = [], k;
    if (v instanceof Array) {
      for (k = 0; k < v.length; k++) parts.push(toJSON(v[k]));
      return '[' + parts.join(',') + ']';
    }
    for (k in v) if (v.hasOwnProperty(k)) parts.push(quote(k) + ':' + toJSON(v[k]));
    return '{' + parts.join(',') + '}';
  }

  /** Figma space (y down, export origin) -> Illustrator document space (y up). */
  function X(x) {
    return x + dx;
  }
  function Y(y) {
    return -(y + dy);
  }
  function P(x, y) {
    return [X(x), Y(y)];
  }

  // ---------- color ----------

  function rgb(c) {
    var col = new RGBColor();
    col.red = Math.round(c.r * 255);
    col.green = Math.round(c.g * 255);
    col.blue = Math.round(c.b * 255);
    return col;
  }

  function hex2(v) {
    var s = Math.round(v).toString(16).toUpperCase();
    return s.length < 2 ? '0' + s : s;
  }

  function hexOf(c) {
    return '#' + hex2(c.r * 255) + hex2(c.g * 255) + hex2(c.b * 255);
  }

  var swatches;

  /** Solid paint -> Illustrator color. Mapped CMYK colors become global (or spot) swatches. */
  function paintColor(paint) {
    if (opts.colorMode === 'RGB' || !paint.cmyk) return rgb(paint.color);
    var k = paint.cmyk;
    var name = paint.swatch || hexOf(paint.color);
    var key = name + '|' + k.join(',') + '|' + !!paint.spot;
    var spot = swatches[key];
    if (!spot) {
      spot = doc.spots.add();
      var cmyk = new CMYKColor();
      cmyk.cyan = k[0];
      cmyk.magenta = k[1];
      cmyk.yellow = k[2];
      cmyk.black = k[3];
      spot.color = cmyk;
      spot.colorType = paint.spot ? ColorModel.SPOT : ColorModel.PROCESS;
      try {
        spot.name = name;
      } catch (e) {
        spot.name = name + ' ' + k.join('/');
      }
      swatches[key] = spot;
    }
    var color = new SpotColor();
    color.spot = spot;
    color.tint = 100;
    return color;
  }

  var BLEND = {
    MULTIPLY: 'MULTIPLY', SCREEN: 'SCREEN', OVERLAY: 'OVERLAY', DARKEN: 'DARKEN', LIGHTEN: 'LIGHTEN',
    COLOR_DODGE: 'COLORDODGE', COLOR_BURN: 'COLORBURN', HARD_LIGHT: 'HARDLIGHT', SOFT_LIGHT: 'SOFTLIGHT',
    DIFFERENCE: 'DIFFERENCE', EXCLUSION: 'EXCLUSION', HUE: 'HUE', SATURATION: 'SATURATIONBLEND',
    COLOR: 'COLORBLEND', LUMINOSITY: 'LUMINOSITY'
  };

  function applyCommon(item, n) {
    item.name = n.name;
    if (n.opacity < 1) item.opacity = item.opacity * n.opacity;
    var mode = BLEND[n.blendMode];
    if (mode) item.blendingMode = BlendModes[mode];
  }

  function finish(item, n) {
    if (!n.visible) item.hidden = true;
    if (n.locked) item.locked = true;
    created++;
  }

  // ---------- geometry ----------

  function hasHandles(sp) {
    for (var i = 0; i < sp.points.length; i++) {
      var p = sp.points[i];
      if (Math.abs(p[2] - p[0]) > EPS || Math.abs(p[3] - p[1]) > EPS || Math.abs(p[4] - p[0]) > EPS || Math.abs(p[5] - p[1]) > EPS) return true;
    }
    return false;
  }

  function addSubpath(container, sp) {
    var path = container.pathItems.add();
    var i, p;
    if (!hasHandles(sp)) {
      var pts = [];
      for (i = 0; i < sp.points.length; i++) pts.push(P(sp.points[i][0], sp.points[i][1]));
      path.setEntirePath(pts);
    } else {
      for (i = 0; i < sp.points.length; i++) {
        p = sp.points[i];
        var pp = path.pathPoints.add();
        pp.anchor = P(p[0], p[1]);
        pp.leftDirection = P(p[2], p[3]);
        pp.rightDirection = P(p[4], p[5]);
        pp.pointType = PointType.CORNER;
      }
    }
    path.closed = sp.closed;
    return path;
  }

  /** Rounded rectangle as cubic points, clockwise from the top-left corner (y down). */
  function roundedRectSubpath(r, radii) {
    var max = Math.min(r.w, r.h) / 2;
    var corners = [
      { c: [r.x, r.y], u: [0, -1], v: [1, 0], rad: radii[0] },
      { c: [r.x + r.w, r.y], u: [1, 0], v: [0, 1], rad: radii[1] },
      { c: [r.x + r.w, r.y + r.h], u: [0, 1], v: [-1, 0], rad: radii[2] },
      { c: [r.x, r.y + r.h], u: [-1, 0], v: [0, -1], rad: radii[3] }
    ];
    var points = [];
    for (var i = 0; i < 4; i++) {
      var k = corners[i], rad = Math.min(k.rad || 0, max);
      if (rad <= EPS) {
        points.push([k.c[0], k.c[1], k.c[0], k.c[1], k.c[0], k.c[1]]);
        continue;
      }
      var a1 = [k.c[0] - k.u[0] * rad, k.c[1] - k.u[1] * rad];
      var a2 = [k.c[0] + k.v[0] * rad, k.c[1] + k.v[1] * rad];
      var h = rad * KAPPA;
      points.push([a1[0], a1[1], a1[0], a1[1], a1[0] + k.u[0] * h, a1[1] + k.u[1] * h]);
      points.push([a2[0], a2[1], a2[0] - k.v[0] * h, a2[1] - k.v[1] * h, a2[0], a2[1]]);
    }
    return { closed: true, points: points };
  }

  function isRounded(radii) {
    return radii && (radii[0] > EPS || radii[1] > EPS || radii[2] > EPS || radii[3] > EPS);
  }

  /** Draws a rect or geometry shape. Returns a PathItem or CompoundPathItem. */
  function drawShape(container, shape) {
    if (shape.rect) {
      if (!isRounded(shape.radii)) return container.pathItems.rectangle(Y(shape.rect.y), X(shape.rect.x), shape.rect.w, shape.rect.h);
      return addSubpath(container, roundedRectSubpath(shape.rect, shape.radii));
    }
    var geo = shape.geometry, total = 0, i, j;
    for (i = 0; i < geo.length; i++) total += geo[i].subpaths.length;
    if (total === 1) {
      for (i = 0; i < geo.length; i++) {
        if (geo[i].subpaths.length) {
          var single = addSubpath(container, geo[i].subpaths[0]);
          single.evenodd = geo[i].evenodd;
          return single;
        }
      }
    }
    var compound = container.compoundPathItems.add();
    for (i = 0; i < geo.length; i++) {
      for (j = 0; j < geo[i].subpaths.length; j++) {
        var p = addSubpath(compound, geo[i].subpaths[j]);
        p.evenodd = geo[i].evenodd;
      }
    }
    return compound;
  }

  /** Paths whose style must be set (a compound path is styled through its members). */
  function styleTargets(item) {
    if (item.typename !== 'CompoundPathItem') return [item];
    var out = [];
    for (var i = 0; i < item.pathItems.length; i++) out.push(item.pathItems[i]);
    return out;
  }

  // ---------- paint ----------

  var CAP = { NONE: 'BUTTENDCAP', ROUND: 'ROUNDENDCAP', SQUARE: 'PROJECTINGENDCAP' };
  var JOIN = { MITER: 'MITERENDJOIN', ROUND: 'ROUNDENDJOIN', BEVEL: 'BEVELENDJOIN' };

  function setFill(item, paint) {
    var t = styleTargets(item);
    for (var i = 0; i < t.length; i++) {
      if (paint) {
        t[i].filled = true;
        t[i].fillColor = paintColor(paint);
      } else t[i].filled = false;
    }
  }

  function setGradientFill(item, paint) {
    var stops = paint.stops || [];
    if (stops.length < 2) {
      setFill(item, stops[0] ? { type: 'solid', color: stops[0].color, opacity: stops[0].opacity, cmyk: stops[0].cmyk } : null);
      return;
    }
    var gr = doc.gradients.add();
    gr.type = paint.type === 'radial' ? GradientType.RADIAL : GradientType.LINEAR;
    while (gr.gradientStops.length < stops.length) gr.gradientStops.add();
    var i, gs, stopPaint;
    for (i = 0; i < stops.length; i++) {
      gs = gr.gradientStops[i];
      gs.rampPoint = Math.max(0, Math.min(100, stops[i].position * 100));
      if (i > 0 && gs.rampPoint <= gr.gradientStops[i - 1].rampPoint) gs.rampPoint = Math.min(100, gr.gradientStops[i - 1].rampPoint + 0.1);
      stopPaint = { type: 'solid', color: stops[i].color, opacity: stops[i].opacity, cmyk: stops[i].cmyk };
      gs.color = rawColor(stopPaint);
      try {
        gs.opacity = Math.max(0, Math.min(100, stops[i].opacity * 100));
      } catch (e) {}
    }
    while (gr.gradientStops.length > stops.length) gr.gradientStops[gr.gradientStops.length - 1].remove();
    var x0 = X(paint.from[0]), y0 = Y(paint.from[1]);
    var x1 = X(paint.to[0]), y1 = Y(paint.to[1]);
    var ddx = x1 - x0, ddy = y1 - y0;
    var len = Math.sqrt(ddx * ddx + ddy * ddy);
    if (len < EPS) len = 1;
    var gc = new GradientColor();
    gc.gradient = gr;
    gc.origin = [x0, y0];
    gc.length = len;
    gc.angle = (Math.atan2(ddy, ddx) * 180) / Math.PI;
    var t = styleTargets(item);
    for (i = 0; i < t.length; i++) {
      t[i].filled = true;
      t[i].fillColor = gc;
    }
  }

  function applyFill(item, paint) {
    if (!paint) setFill(item, null);
    else if (paint.type === 'linear' || paint.type === 'radial') setGradientFill(item, paint);
    else if (paint.type === 'solid') setFill(item, paint);
    else setFill(item, null);
  }

  function setStroke(item, stroke, name) {
    var t = styleTargets(item);
    var cap = stroke ? CAP[stroke.cap] : null;
    var join = stroke ? JOIN[stroke.join] : null;
    for (var i = 0; i < t.length; i++) {
      if (!stroke) {
        t[i].stroked = false;
        continue;
      }
      t[i].stroked = true;
      t[i].strokeColor = paintColor(stroke.paint);
      t[i].strokeWidth = stroke.weight;
      if (cap) t[i].strokeCap = StrokeCap[cap];
      if (join) t[i].strokeJoin = StrokeJoin[join];
      t[i].strokeMiterLimit = Math.max(1, stroke.miterLimit);
      if (stroke.dashes.length) t[i].strokeDashes = stroke.dashes;
    }
  }

  function solids(paints) {
    var out = [];
    for (var i = 0; i < paints.length; i++) if (paints[i].type === 'solid') out.push(paints[i]);
    return out;
  }

  function grads(paints) {
    var out = [];
    for (var i = 0; i < paints.length; i++) if (paints[i].type === 'linear' || paints[i].type === 'radial') out.push(paints[i]);
    return out;
  }

  function hasImage(paints) {
    for (var i = 0; i < paints.length; i++) if (paints[i].type === 'image') return true;
    return false;
  }

  function placeImage(container, paint, name) {
    var f = new File(assetDir + '/' + paint.ref);
    if (!f.exists) {
      warn(name + ': image file missing (' + paint.ref + ')');
      return null;
    }
    var item = container.placedItems.add();
    item.file = f;
    item.width = paint.rect.w;
    item.height = paint.rect.h;
    item.position = P(paint.rect.x, paint.rect.y);
    item.name = name;
    if (paint.opacity < 1) item.opacity = paint.opacity * 100;
    if (opts.embedImages) {
      try {
        item.embed();
      } catch (e) {
        warn(name + ': image left linked (' + e.message + ')');
      }
    }
    return item;
  }

  /**
   * Draws a shape with its fills and strokes.
   * Simple case: one path. With images or several fills: a clip group
   * (fill layers + image + clip path), plus a stroke path on top.
   */
  function paintedShape(container, shape, fills, strokes, name) {
    var solidFills = solids(fills);
    var gradientFills = grads(fills);
    var stroke = strokes.length ? strokes[strokes.length - 1] : null;
    if (strokes.length > 1) warn(name + ': only the top stroke is transferred');

    if (!hasImage(fills) && solidFills.length + gradientFills.length <= 1 && (!stroke || stroke.align === 'CENTER')) {
      var item = drawShape(container, shape);
      var fill = gradientFills[0] || solidFills[0] || null;
      applyFill(item, fill);
      setStroke(item, stroke, name);
      if (fill && fill.opacity < 1) {
        if (stroke) warn(name + ': fill opacity also applied to stroke');
        item.opacity = fill.opacity * 100;
      } else if (!fill && stroke && stroke.paint.opacity < 1) {
        item.opacity = stroke.paint.opacity * 100;
      } else if (fill && stroke && stroke.paint.opacity < 1) {
        warn(name + ': stroke opacity is not transferred');
      }
      return item;
    }

    var outer = stroke ? container.groupItems.add() : container;
    var clip = outer.groupItems.add();
    clip.name = name;
    for (var i = 0; i < fills.length; i++) {
      var p = fills[i];
      if (p.type === 'image') placeImage(clip, p, name);
      else {
        var layer = drawShape(clip, shape);
        applyFill(layer, p);
        setStroke(layer, null, name);
        if (p.opacity < 1) layer.opacity = p.opacity * 100;
      }
    }
    var mask = drawShape(clip, shape);
    makeClipping(clip, mask);
    if (!stroke) return clip;

    var line = drawShape(outer, shape);
    applyFill(line, null);
    var aligned = { paint: stroke.paint, weight: stroke.weight, align: stroke.align, cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit, dashes: stroke.dashes };
    if (stroke.align === 'INSIDE' || stroke.align === 'OUTSIDE') aligned.weight = stroke.weight * 2;
    setStroke(line, aligned, name);
    if (stroke.align === 'INSIDE') {
      var strokeClip = drawShape(outer, shape);
      makeClipping(outer, strokeClip);
    } else if (stroke.align === 'OUTSIDE') {
      line.zOrder(ZOrderMethod.SENDTOBACK);
      if (!solidFills.length && !gradientFills.length && !hasImage(fills)) {
        warn(name + ': outside stroke without a fill is an approximation');
      }
    }
    outer.name = name;
    return outer;
  }

  function makeClipping(group, mask) {
    var t = styleTargets(mask);
    for (var i = 0; i < t.length; i++) {
      t[i].filled = false;
      t[i].stroked = false;
      t[i].clipping = true;
    }
    group.clipped = true;
  }

  // ---------- text ----------

  function normFont(s) {
    return String(s).toLowerCase().replace(/[\s\-_]/g, '');
  }

  /** Maps family|style to PostScript names; TextFont objects go stale while fonts load, so they are not cached. */
  function buildFontIndex() {
    fontIndex = {};
    var fonts = app.textFonts;
    for (var i = 0; i < fonts.length; i++) {
      var f = fonts[i];
      var key = normFont(f.family) + '|' + normFont(f.style);
      if (!fontIndex[key]) fontIndex[key] = f.name;
    }
  }

  var missingFonts = {};

  /** Returns the PostScript name of the closest installed font, or null. */
  function findFont(family, style) {
    if (!fontIndex) buildFontIndex();
    var name = fontIndex[normFont(family) + '|' + normFont(style)];
    if (name) return name;
    var key = family + ' ' + style;
    if (!missingFonts[key]) {
      missingFonts[key] = true;
      warn('Font missing in Illustrator: ' + key);
    }
    return fontIndex[normFont(family) + '|regular'] || null;
  }

  var failedFonts = {};

  function setFont(ca, name) {
    if (!name) return;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        ca.textFont = app.textFonts.getByName(name);
        return;
      } catch (e) {
        $.sleep(150);
      }
    }
    if (!failedFonts[name]) {
      failedFonts[name] = true;
      warn('Font ' + name + ' could not be applied to some text (Illustrator still loading fonts?)');
    }
  }

  /** Ascent and descent of a font at a size, measured from a temporary point text. */
  function fontMetrics(container, font, size) {
    var key = (font || '?') + '@' + size;
    if (metricsCache[key]) return metricsCache[key];
    var t = container.textFrames.pointText([0, 0]);
    t.contents = 'Hg';
    var ca = t.textRange.characterAttributes;
    setFont(ca, font);
    ca.size = size;
    var b = t.geometricBounds; // [left, top, right, bottom]
    var m = { ascent: b[1], descent: -b[3] };
    t.remove();
    metricsCache[key] = m;
    return m;
  }

  function applyCase(s, mode) {
    if (mode === 'LOWER') return s.toLowerCase();
    if (mode === 'TITLE') return s.replace(/(^|\s)(\S)/g, function (all, sp, ch) { return sp + ch.toUpperCase(); });
    return s;
  }

  function aiText(s) {
    return s.replace(/\u2028/g, '\u0003').replace(/\r\n|\n/g, '\r');
  }

  var JUSTIFY = { LEFT: 'LEFT', CENTER: 'CENTER', RIGHT: 'RIGHT', JUSTIFIED: 'FULLJUSTIFYLASTLINELEFT' };

  function buildText(container, n) {
    var runs = n.runs, i;
    if (!runs.length) return null;
    var first = runs[0];
    var firstFont = findFont(first.fontFamily, first.fontStyle);
    var metrics = fontMetrics(container, firstFont, first.fontSize);
    var lineHeight = first.lineHeight !== null ? first.lineHeight : metrics.ascent + metrics.descent;
    // Figma centers the glyph box (ascent + descent) inside the line height.
    var baseline = (lineHeight - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;

    var contents = '';
    for (i = 0; i < runs.length; i++) contents += applyCase(n.characters.substring(runs[i].start, runs[i].end), runs[i].textCase);

    var r = n.rect, tf;
    var point = n.autoResize === 'WIDTH_AND_HEIGHT';
    if (point) {
      // ExtendScript mis-parses nested ternaries.
      var ax = r.x;
      if (n.alignH === 'CENTER') ax = r.x + r.w / 2;
      else if (n.alignH === 'RIGHT') ax = r.x + r.w;
      tf = container.textFrames.pointText(P(ax, r.y + baseline));
    } else {
      // Extra height keeps the last line from going overset when Illustrator metrics differ slightly.
      // TRUNCATE and NONE stay in the box; HEIGHT gets slack so the last line is not overset.
      var slack = n.autoResize === 'HEIGHT' ? lineHeight : 0;
      var box = container.pathItems.rectangle(Y(r.y), X(r.x), r.w, r.h + slack);
      tf = container.textFrames.areaText(box);
      tf.firstBaseline = FirstBaselineType.BASELINEFIXED;
      tf.firstBaselineMin = baseline;
      if (n.autoResize === 'NONE' && n.alignV !== 'TOP') warn(n.name + ': vertical text alignment ' + n.alignV + ' is not transferred');
    }
    tf.contents = aiText(contents);

    var para = tf.textRange.paragraphAttributes;
    para.justification = Justification[JUSTIFY[n.alignH] || 'LEFT'];
    para.spaceAfter = n.paragraphSpacing || 0;

    for (i = 0; i < runs.length; i++) {
      var run = runs[i];
      if (run.end <= run.start) continue;
      var range = tf.textRange.characters[run.start];
      range.length = run.end - run.start;
      var ca = range.characterAttributes;
      var font = findFont(run.fontFamily, run.fontStyle);
      setFont(ca, font);
      ca.size = run.fontSize;
      ca.tracking = Math.round((run.letterSpacing / run.fontSize) * 1000);
      ca.autoLeading = false;
      if (run.lineHeight !== null) ca.leading = run.lineHeight;
      else {
        var rm = fontMetrics(container, font, run.fontSize);
        ca.leading = rm.ascent + rm.descent;
      }
      if (run.fill) {
        ca.fillColor = paintColor(run.fill);
        if (run.fill.opacity < 1) warn(n.name + ': text color opacity is not transferred');
      }
      if (run.textCase === 'UPPER') ca.capitalization = FontCapsOption.ALLCAPS;
      else if (run.textCase === 'SMALL_CAPS' || run.textCase === 'SMALL_CAPS_FORCED') ca.capitalization = FontCapsOption.SMALLCAPS;
      if (run.decoration === 'UNDERLINE') ca.underline = true;
      if (run.decoration === 'STRIKETHROUGH') ca.strikeThrough = true;
    }

    var m = n.matrix;
    if (Math.abs(m[1]) > EPS || Math.abs(m[2]) > EPS || m[0] < 0 || m[3] < 0) {
      var mat = app.getIdentityMatrix();
      mat.mValueA = m[0];
      mat.mValueB = -m[1];
      mat.mValueC = -m[2];
      mat.mValueD = m[3];
      var before = point ? null : tf.textPath.pathPoints[0].anchor;
      tf.transform(mat, true, true, true, true, 1, Transformation.TOPLEFT);
      if (before) {
        var after = tf.textPath.pathPoints[0].anchor;
        tf.translate(before[0] - after[0], before[1] - after[1]);
      }
    }
    return tf;
  }

  // ---------- nodes ----------

  function buildNode(container, n) {
    try {
      buildNodeUnsafe(container, n);
    } catch (e) {
      warn('"' + n.name + '" skipped: ' + e.message + (e.line ? ' (line ' + e.line + ')' : ''));
    }
  }

  function buildNodeUnsafe(container, n) {
    var item;
    if (n.type === 'group') item = buildGroup(container, n);
    else if (n.type === 'rect') item = paintedShape(container, { rect: n.rect, radii: n.radii }, n.fills, n.strokes, n.name);
    else if (n.type === 'path') item = paintedShape(container, { geometry: n.geometry }, n.fills, n.strokes, n.name);
    else if (n.type === 'text') item = buildText(container, n);
    else {
      warn('Unknown node type ' + n.type);
      return;
    }
    if (!item) return;
    applyCommon(item, n);
    finish(item, n);
  }

  function rawColor(paint) {
    if (opts.colorMode !== 'RGB' && paint.cmyk) {
      var cmyk = new CMYKColor();
      cmyk.cyan = paint.cmyk[0];
      cmyk.magenta = paint.cmyk[1];
      cmyk.yellow = paint.cmyk[2];
      cmyk.black = paint.cmyk[3];
      return cmyk;
    }
    return rgb(paint.color);
  }

  /** Process color for a gradient stop; must match the artboard fill, not a second RGB conversion. */
  function fadeInk() {
    var col = pageFill;
    if (col && col.typename === 'SpotColor' && col.spot) col = col.spot.color;
    if (col && (col.typename === 'CMYKColor' || col.typename === 'RGBColor' || col.typename === 'GrayColor')) {
      return col;
    }
    return null;
  }

  /** Photo fade: Illustrator ignores GradientColor.angle, so the overlay is built along the fade axis and rotated with its fill. */
  function addFadeOverlay(group, mask) {
    if (!mask.reveal) {
      warn('Fade mask: no solid color behind the photo, fade skipped');
      return;
    }
    var x0 = X(mask.from[0]), y0 = Y(mask.from[1]);
    var x1 = X(mask.to[0]), y1 = Y(mask.to[1]);
    var ddx = x1 - x0, ddy = y1 - y0;
    var len = Math.sqrt(ddx * ddx + ddy * ddy);
    if (len < EPS) return;
    var vx = -ddy / len, vy = ddx / len;
    var b = group.geometricBounds;
    var corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    var minP = 0, maxP = 0, i, proj;
    for (i = 0; i < 4; i++) {
      proj = (corners[i][0] - x0) * vx + (corners[i][1] - y0) * vy;
      if (proj < minP) minP = proj;
      if (proj > maxP) maxP = proj;
    }
    var half = Math.max(Math.abs(minP), Math.abs(maxP)) + 2;
    if (half < 1) half = 1;

    var r = group.pathItems.rectangle(half, 0, len, 2 * half);
    var gr = doc.gradients.add();
    gr.type = GradientType.LINEAR;
    var color = fadeInk() || rawColor(mask.reveal);
    var a = mask.stops[0], z = mask.stops[mask.stops.length - 1];
    gr.gradientStops[0].rampPoint = Math.max(0, Math.min(99, a.position * 100));
    gr.gradientStops[0].color = color;
    gr.gradientStops[0].opacity = (1 - a.opacity) * 100;
    gr.gradientStops[1].rampPoint = Math.max(gr.gradientStops[0].rampPoint + 0.1, Math.min(100, z.position * 100));
    gr.gradientStops[1].color = color;
    gr.gradientStops[1].opacity = (1 - z.opacity) * 100;
    var gc = new GradientColor();
    gc.gradient = gr;
    r.fillColor = gc;
    r.stroked = false;
    r.name = 'Fade';
    r.translate(x0, y0);
    r.rotate((Math.atan2(ddy, ddx) * 180) / Math.PI, true, true, true, true, Transformation.LEFT);
  }

  function buildGroup(container, n) {
    var g = container.groupItems.add();
    try {
      var frame = n.frame;
      var shape = null;
      if (frame && frame.rect) shape = { rect: frame.rect, radii: frame.radii };
      else if (frame) shape = { geometry: frame.geometry };

      if (shape && (n.fills.length || n.strokes.length)) {
        var bg = paintedShape(g, shape, n.fills, n.strokes, 'Background');
        bg.name = 'Background';
      }
      for (var i = 0; i < n.children.length; i++) buildNode(g, n.children[i]);
      if (n.opacityMask) addFadeOverlay(g, n.opacityMask);
      if (n.clipGeometry) makeClipping(g, drawShape(g, { geometry: n.clipGeometry }));
      else if (frame && frame.clip) makeClipping(g, drawShape(g, shape));
      return g;
    } catch (e) {
      try {
        g.remove();
      } catch (x) {}
      throw e;
    }
  }

  // ---------- document ----------

  function bleedOf(ab) {
    var l = ab.trim.x - ab.rect.x;
    var t = ab.trim.y - ab.rect.y;
    var r = ab.rect.x + ab.rect.w - (ab.trim.x + ab.trim.w);
    var b = ab.rect.y + ab.rect.h - (ab.trim.y + ab.trim.h);
    return [l, t, r, b];
  }

  function manualBleed() {
    return opts.bleedMm === null || opts.bleedMm === undefined ? null : (opts.bleedMm * 72) / 25.4;
  }

  /** Painted area of an artboard: the Figma frame, or trim plus the manual bleed. */
  function artboardArea(ab) {
    var b = manualBleed();
    if (b === null) return ab.rect;
    return { x: ab.trim.x - b, y: ab.trim.y - b, w: ab.trim.w + 2 * b, h: ab.trim.h + 2 * b };
  }

  function createDocument(artboards) {
    var first = artboards[0];
    var b = manualBleed();
    var bleed = b === null ? bleedOf(first) : [b, b, b, b];
    var space = opts.colorMode === 'RGB' ? DocumentColorSpace.RGB : DocumentColorSpace.CMYK;
    var d = app.documents.add(space, first.trim.w, first.trim.h);
    if (bleed[0] < 0.01 && bleed[1] < 0.01 && bleed[2] < 0.01 && bleed[3] < 0.01) return d;
    try {
      var r = F2ABleed.apply(d, bleed, Folder.temp.fsName.replace(/\\/g, '/'));
      if (r.error) warn('Bleed could not be set (' + r.error + ')');
      return r.doc;
    } catch (e) {
      warn('Bleed could not be set (' + e.message + ')');
      return d;
    }
  }

  /** Lays artboards out in rows so they fit Illustrator's canvas; returns trim positions. */
  function layout(artboards) {
    var GAP = 60, MAX_ROW = 7000;
    var x = 0, y = 0, rowH = 0, out = [];
    for (var i = 0; i < artboards.length; i++) {
      var t = artboards[i].trim;
      if (x > 0 && x + t.w > MAX_ROW) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      out.push({ x: x, y: y });
      x += t.w + GAP;
      rowH = Math.max(rowH, t.h);
    }
    return out;
  }

  function sortArtboards(list) {
    var copy = list.slice(0);
    copy.sort(function (a, b) {
      return Math.abs(a.rect.y - b.rect.y) > 1 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x;
    });
    return copy;
  }

  function buildArtboard(ab, index, pos) {
    dx = pos.x - ab.trim.x;
    dy = pos.y - ab.trim.y;
    var rect = [X(ab.trim.x), Y(ab.trim.y), X(ab.trim.x + ab.trim.w), Y(ab.trim.y + ab.trim.h)];
    var board = index === 0 ? doc.artboards[0] : doc.artboards.add(rect);
    board.artboardRect = rect;
    board.name = ab.name;

    var layer = index === 0 ? doc.layers[0] : doc.layers.add();
    layer.name = ab.name;

    pageFill = null;
    var root = layer;
    if (ab.clip) {
      root = layer.groupItems.add();
      root.name = ab.name;
    }
    var area = artboardArea(ab);
    if (ab.fills.length) {
      var bg = paintedShape(root, { rect: area, radii: [0, 0, 0, 0] }, ab.fills, [], 'Background');
      bg.name = 'Background';
      var targets = styleTargets(bg);
      if (targets.length) pageFill = targets[0].fillColor;
    }
    for (var i = 0; i < ab.children.length; i++) buildNode(root, ab.children[i]);
    if (ab.clip) makeClipping(root, drawShape(root, { rect: area, radii: [0, 0, 0, 0] }));

    if (index > 0 && manualBleed() === null) {
      var b = bleedOf(ab), b0 = bleedOf(firstArtboard);
      for (var k = 0; k < 4; k++) {
        if (Math.abs(b[k] - b0[k]) > 0.01) {
          warn(ab.name + ': bleed differs from the first artboard; Illustrator has one bleed per document');
          break;
        }
      }
    }
  }

  function build(path) {
    warnings = [];
    created = 0;
    fontIndex = null;
    metricsCache = {};
    missingFonts = {};
    failedFonts = {};
    swatches = {};
    pageFill = null;
    var data = readJSON(path);
    opts = data.options;
    assetDir = data.assetDir;
    if (!data.artboards.length) throw new Error('No artboards in payload');

    var prevLevel = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    try {
      var artboards = sortArtboards(data.artboards);
      firstArtboard = artboards[0];
      doc = createDocument(artboards);
      try {
        doc.rasterEffectSettings.resolution = opts.ppi || 300;
      } catch (e) {
        warn('Raster PPI could not be set (' + e.message + ')');
      }
      app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
      var positions = layout(artboards);
      for (var i = 0; i < artboards.length; i++) buildArtboard(artboards[i], i, positions[i]);
      doc.artboards.setActiveArtboardIndex(0);
    } finally {
      app.userInteractionLevel = prevLevel;
    }
    return { ok: true, created: created, warnings: warnings };
  }

  // ---------- color preview ----------

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  function hexToRgb(hex) {
    var n = parseInt(String(hex).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbHex(c) {
    return '#' + hex2(Math.max(0, Math.min(255, c[0]))) + hex2(Math.max(0, Math.min(255, c[1]))) + hex2(Math.max(0, Math.min(255, c[2])));
  }

  function convertSample(from, values, to) {
    return app.convertSampleColor(from, values, to, ColorConvertPurpose.defaultpurpose);
  }

  function rad(d) {
    return (d * Math.PI) / 180;
  }

  function deg(r) {
    var d = (r * 180) / Math.PI;
    return d < 0 ? d + 360 : d;
  }

  /** CIEDE2000 color difference between two Lab colors. */
  function deltaE00(p, q) {
    var L1 = p[0], a1 = p[1], b1 = p[2], L2 = q[0], a2 = q[1], b2 = q[2];
    var C1 = Math.sqrt(a1 * a1 + b1 * b1), C2 = Math.sqrt(a2 * a2 + b2 * b2);
    var Cm7 = Math.pow((C1 + C2) / 2, 7);
    var G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + 6103515625)));
    var a1p = a1 * (1 + G), a2p = a2 * (1 + G);
    var C1p = Math.sqrt(a1p * a1p + b1 * b1), C2p = Math.sqrt(a2p * a2p + b2 * b2);
    var h1p = C1p === 0 ? 0 : deg(Math.atan2(b1, a1p));
    var h2p = C2p === 0 ? 0 : deg(Math.atan2(b2, a2p));
    var dLp = L2 - L1, dCp = C2p - C1p, dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    var dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
    var Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2, hpm = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) <= 180) hpm = (h1p + h2p) / 2;
      else if (h1p + h2p < 360) hpm = (h1p + h2p + 360) / 2;
      else hpm = (h1p + h2p - 360) / 2;
    }
    var T = 1 - 0.17 * Math.cos(rad(hpm - 30)) + 0.24 * Math.cos(rad(2 * hpm)) + 0.32 * Math.cos(rad(3 * hpm + 6)) - 0.2 * Math.cos(rad(4 * hpm - 63));
    var dTheta = 30 * Math.exp(-Math.pow((hpm - 275) / 25, 2));
    var Cpm7 = Math.pow(Cpm, 7);
    var Rc = 2 * Math.sqrt(Cpm7 / (Cpm7 + 6103515625));
    var Sl = 1 + (0.015 * Math.pow(Lpm - 50, 2)) / Math.sqrt(20 + Math.pow(Lpm - 50, 2));
    var Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
    var Rt = -Math.sin(rad(2 * dTheta)) * Rc;
    var l = dLp / Sl, c = dCp / Sc, h = dHp / Sh;
    return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
  }

  var MAX_INK = 300;

  function cmykLab(c) {
    return convertSample(ImageColorSpace.CMYK, c, ImageColorSpace.LAB);
  }

  /** Pattern search for the in-limit CMYK whose printed color is closest to the target Lab. */
  function optimize(start, target) {
    var best = start.slice(0), bestDe = deltaE00(cmykLab(best), target);
    var steps = [16, 8, 4, 2, 1];
    for (var s = 0; s < steps.length; s++) {
      var step = steps[s];
      for (var iter = 0; iter < 40; iter++) {
        var cand = null, candDe = bestDe - 0.01;
        for (var n = 1; n < 81; n++) {
          var c = [], sum = 0, ok = true;
          for (var k = 0, m = n; k < 4; k++, m = Math.floor(m / 3)) {
            var v = best[k] + ((m % 3) - 1) * step;
            if (v < 0 || v > 100) {
              ok = false;
              break;
            }
            c.push(v);
            sum += v;
          }
          if (!ok || sum > MAX_INK) continue;
          var de = deltaE00(cmykLab(c), target);
          if (de < candDe) {
            cand = c;
            candDe = de;
          }
        }
        if (!cand) break;
        best = cand;
        bestDe = candDe;
      }
    }
    return { cmyk: best, de: bestDe };
  }

  function roundInks(c) {
    var out = [], sum = 0, k;
    for (k = 0; k < 4; k++) {
      out.push(Math.round(c[k]));
      sum += out[k];
    }
    for (k = 2; sum > MAX_INK && k >= 0; k--) {
      var cut = Math.min(out[k], sum - MAX_INK);
      out[k] -= cut;
      sum -= cut;
    }
    return out;
  }

  /**
   * { rgb: ['#RRGGBB'], proof: [{ cmyk, hex }] } -> conversions with Illustrator's color settings.
   * rgb: closest printable CMYK (ICC conversion, then refined by search when it misses), gray, proof.
   * proof: on-screen preview of a CMYK value and its difference from the Figma color.
   */
  function convert(req) {
    var out = { rgb: [], proof: [] }, i;
    for (i = 0; i < (req.rgb || []).length; i++) {
      var hex = req.rgb[i];
      var rgbv = hexToRgb(hex);
      var target = convertSample(ImageColorSpace.RGB, rgbv, ImageColorSpace.LAB);
      var icc = roundInks(convertSample(ImageColorSpace.RGB, rgbv, ImageColorSpace.CMYK));
      var iccDe = deltaE00(cmykLab(icc), target);
      var best = iccDe > 1 ? optimize(icc, target) : { cmyk: icc, de: iccDe };
      var g = convertSample(ImageColorSpace.RGB, rgbv, ImageColorSpace.GrayScale);
      out.rgb.push({
        hex: hex,
        cmyk: best.cmyk,
        de: round1(best.de),
        icc: icc,
        iccDe: round1(iccDe),
        gray: round1(g[0]),
        proof: rgbHex(convertSample(ImageColorSpace.CMYK, best.cmyk, ImageColorSpace.RGB))
      });
    }
    for (i = 0; i < (req.proof || []).length; i++) {
      var p = req.proof[i];
      out.proof.push({
        proof: rgbHex(convertSample(ImageColorSpace.CMYK, p.cmyk, ImageColorSpace.RGB)),
        de: round1(deltaE00(cmykLab(p.cmyk), convertSample(ImageColorSpace.RGB, hexToRgb(p.hex), ImageColorSpace.LAB)))
      });
    }
    return out;
  }

  return {
    build: function (path) {
      try {
        return toJSON(build(path));
      } catch (e) {
        return toJSON({ ok: false, error: e.message + (e.line ? ' (line ' + e.line + ')' : ''), warnings: warnings || [] });
      }
    },
    convert: function (json) {
      try {
        var res = convert(eval('(' + json + ')'));
        res.ok = true;
        return toJSON(res);
      } catch (e) {
        return toJSON({ ok: false, error: e.message + (e.line ? ' (line ' + e.line + ')' : '') });
      }
    }
  };
})();

function f2aBuild(path) {
  return F2A.build(path);
}

function f2aConvert(json) {
  return F2A.convert(json);
}
