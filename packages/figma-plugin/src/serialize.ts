import {
  IR_VERSION,
  type BuildOptions,
  type IRArtboard,
  type IRDocument,
  type IRGeometry,
  type IRGradientPaint,
  type IRGroupNode,
  type IRImagePaint,
  type IRNode,
  type IROpacityMask,
  type IRPaint,
  type IRPoint,
  type IRRect,
  type IRSolidPaint,
  type IRStroke,
  type IRSubpath,
  type IRTextNode,
  type IRTextRun,
} from '@f2a/schema';

export interface Asset {
  ref: string;
  bytes: Uint8Array;
}

interface Ctx {
  ox: number;
  oy: number;
  warnings: string[];
  assets: Map<string, Asset>;
  /** Solid behind the current artboard, used for fade overlays. */
  reveal?: IRSolidPaint;
  ppi: number;
}

type Vec = [number, number];
const EPS = 1e-6;

function apply(m: Transform, x: number, y: number, ctx: Ctx): Vec {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] - ctx.ox,
    m[1][0] * x + m[1][1] * y + m[1][2] - ctx.oy,
  ];
}

function isAxisAligned(m: Transform): boolean {
  return Math.abs(m[0][1]) < EPS && Math.abs(m[1][0]) < EPS && m[0][0] > 0 && m[1][1] > 0;
}

function mappedRect(m: Transform, w: number, h: number, ctx: Ctx): IRRect {
  const [x, y] = apply(m, 0, 0, ctx);
  return { x, y, w: w * m[0][0], h: h * m[1][1] };
}

function label(node: BaseNode): string {
  return `${node.type} "${node.name}"`;
}

// ---------- geometry ----------

const TOKEN = /[MLQCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Parses Figma's normalized SVG path data (absolute M/L/Q/C/Z) into cubic subpaths. */
export function parsePath(d: string, map: (x: number, y: number) => Vec): IRSubpath[] {
  const tokens = d.match(TOKEN) ?? [];
  const subpaths: { closed: boolean; pts: { a: Vec; i: Vec; o: Vec }[] }[] = [];
  let cur: (typeof subpaths)[number] | null = null;
  let last: Vec = [0, 0];
  let k = 0;
  const num = () => parseFloat(tokens[k++]);

  while (k < tokens.length) {
    const cmd = tokens[k++].toUpperCase();
    if (cmd === 'M') {
      last = [num(), num()];
      cur = { closed: false, pts: [{ a: last, i: last, o: last }] };
      subpaths.push(cur);
    } else if (cmd === 'L' && cur) {
      last = [num(), num()];
      cur.pts.push({ a: last, i: last, o: last });
    } else if (cmd === 'C' && cur) {
      const c1: Vec = [num(), num()];
      const c2: Vec = [num(), num()];
      last = [num(), num()];
      cur.pts[cur.pts.length - 1].o = c1;
      cur.pts.push({ a: last, i: c2, o: last });
    } else if (cmd === 'Q' && cur) {
      const q: Vec = [num(), num()];
      const p: Vec = [num(), num()];
      const p0 = last;
      cur.pts[cur.pts.length - 1].o = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])];
      cur.pts.push({ a: p, i: [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], o: p });
      last = p;
    } else if (cmd === 'Z' && cur) {
      cur.closed = true;
      const first = cur.pts[0];
      const end = cur.pts[cur.pts.length - 1];
      if (cur.pts.length > 1 && Math.abs(end.a[0] - first.a[0]) < EPS && Math.abs(end.a[1] - first.a[1]) < EPS) {
        first.i = end.i;
        cur.pts.pop();
      }
      last = first.a;
    }
  }

  return subpaths.map((sp) => ({
    closed: sp.closed,
    points: sp.pts.map(({ a, i, o }) => {
      const A = map(a[0], a[1]);
      const I = map(i[0], i[1]);
      const O = map(o[0], o[1]);
      return [A[0], A[1], I[0], I[1], O[0], O[1]] as IRPoint;
    }),
  }));
}

function geometryFrom(paths: readonly (VectorPath | { data: string; windingRule: string })[], m: Transform, ctx: Ctx): IRGeometry[] {
  const map = (x: number, y: number) => apply(m, x, y, ctx);
  return paths.map((p) => ({ evenodd: p.windingRule === 'EVENODD', subpaths: parsePath(p.data, map) }));
}

// ---------- paints ----------

async function swatchName(paint: SolidPaint, styleId: string | typeof figma.mixed | undefined): Promise<string | undefined> {
  const varId = paint.boundVariables?.color?.id;
  if (varId) {
    const v = await figma.variables.getVariableByIdAsync(varId);
    if (v) return v.name;
  }
  if (typeof styleId === 'string' && styleId) {
    const s = await figma.getStyleByIdAsync(styleId);
    if (s) return s.name;
  }
  return undefined;
}

async function solid(paint: SolidPaint, styleId?: string | typeof figma.mixed): Promise<IRSolidPaint> {
  const { r, g, b } = paint.color;
  return { type: 'solid', color: { r, g, b }, opacity: paint.opacity ?? 1, swatch: await swatchName(paint, styleId) };
}

function sniffExt(bytes: Uint8Array): string {
  if (bytes.length < 2) return 'bin';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  return 'bin';
}

async function imagePaint(paint: ImagePaint, node: SceneNode & LayoutMixin, ctx: Ctx): Promise<IRImagePaint | null> {
  if (!paint.imageHash) return null;
  const image = figma.getImageByHash(paint.imageHash);
  if (!image) return null;

  let asset = ctx.assets.get(paint.imageHash);
  if (!asset) {
    const bytes = await image.getBytesAsync();
    asset = { ref: `${paint.imageHash}.${sniffExt(bytes)}`, bytes };
    ctx.assets.set(paint.imageHash, asset);
  }
  const { width: iw, height: ih } = await image.getSizeAsync();
  const w = node.width;
  const h = node.height;

  let local: IRRect;
  if (paint.scaleMode === 'CROP' && paint.imageTransform) {
    const t = paint.imageTransform;
    if (Math.abs(t[0][1]) > EPS || Math.abs(t[1][0]) > EPS) ctx.warnings.push(`${label(node)}: rotated image crop is approximated`);
    const x0 = -t[0][2] / t[0][0];
    const y0 = -t[1][2] / t[1][1];
    local = { x: x0 * w, y: y0 * h, w: (1 / t[0][0]) * w, h: (1 / t[1][1]) * h };
  } else {
    if (paint.scaleMode === 'TILE') ctx.warnings.push(`${label(node)}: tiled image placed as FILL`);
    const s = paint.scaleMode === 'FIT' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
    local = { x: (w - iw * s) / 2, y: (h - ih * s) / 2, w: iw * s, h: ih * s };
  }
  if (paint.rotation) ctx.warnings.push(`${label(node)}: image rotation ${paint.rotation}° is not supported yet`);
  if (paint.filters && Object.values(paint.filters).some((v) => v)) ctx.warnings.push(`${label(node)}: image adjustments (exposure, contrast…) are not transferred`);

  const m = node.absoluteTransform;
  if (!isAxisAligned(m)) ctx.warnings.push(`${label(node)}: image on rotated layer is placed unrotated`);
  const [x, y] = apply(m, local.x, local.y, ctx);
  const placedW = local.w * Math.abs(m[0][0]);
  const placedH = local.h * Math.abs(m[1][1]);
  return { type: 'image', ref: asset.ref, opacity: paint.opacity ?? 1, rect: { x, y, w: placedW, h: placedH } };
}

async function fillsOf(node: SceneNode, ctx: Ctx): Promise<IRPaint[]> {
  if (!('fills' in node) || node.fills === figma.mixed) return [];
  const styleId = 'fillStyleId' in node ? node.fillStyleId : undefined;
  const out: IRPaint[] = [];
  for (const p of node.fills) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') out.push(await solid(p, node.fills.length === 1 ? styleId : undefined));
    else if (p.type === 'IMAGE') {
      const img = await imagePaint(p, node as SceneNode & LayoutMixin, ctx);
      if (img) out.push(img);
    } else if ('gradientStops' in p) {
      out.push(gradientPaint(p, node as SceneNode & LayoutMixin, ctx));
    } else {
      ctx.warnings.push(`${label(node)}: ${p.type} fill is not supported`);
    }
  }
  return out;
}

async function strokesOf(node: SceneNode, ctx: Ctx): Promise<IRStroke[]> {
  if (!('strokes' in node) || !node.strokes.length) return [];
  const g = node as SceneNode & GeometryMixin & MinimalStrokesMixin;
  let weight = g.strokeWeight;
  if (weight === figma.mixed) {
    const ind = node as SceneNode & IndividualStrokesMixin;
    weight = Math.max(ind.strokeTopWeight, ind.strokeRightWeight, ind.strokeBottomWeight, ind.strokeLeftWeight);
    ctx.warnings.push(`${label(node)}: per-side stroke weights merged into ${weight}pt`);
  }
  if (!weight) return [];
  const cap = g.strokeCap === figma.mixed ? 'NONE' : g.strokeCap;
  const join = g.strokeJoin === figma.mixed ? 'MITER' : g.strokeJoin;
  const styleId = 'strokeStyleId' in node ? node.strokeStyleId : undefined;
  const out: IRStroke[] = [];
  for (const p of node.strokes) {
    if (p.visible === false) continue;
    if (p.type !== 'SOLID') {
      ctx.warnings.push(`${label(node)}: ${p.type} stroke is not supported yet`);
      continue;
    }
    out.push({
      paint: await solid(p, node.strokes.length === 1 ? styleId : undefined),
      weight,
      align: g.strokeAlign,
      cap: cap === 'ROUND' || cap === 'SQUARE' ? cap : 'NONE',
      join,
      miterLimit: g.strokeMiterLimit,
      dashes: [...g.dashPattern],
    });
  }
  return out;
}

// ---------- nodes ----------

function base(node: SceneNode) {
  return {
    id: node.id,
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: 'opacity' in node ? node.opacity : 1,
    blendMode: 'blendMode' in node ? node.blendMode : 'NORMAL',
  };
}

function radiiOf(node: SceneNode): [number, number, number, number] {
  if ('topLeftRadius' in node) {
    return [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
  }
  return [0, 0, 0, 0];
}

function warnEffects(node: SceneNode, ctx: Ctx) {
  if ('effects' in node && node.effects.some((e) => e.visible)) {
    ctx.warnings.push(`${label(node)}: effects (shadow/blur) are not transferred yet`);
  }
}

async function serializeText(node: TextNode, ctx: Ctx): Promise<IRTextNode> {
  const segments = node.getStyledTextSegments([
    'fontName',
    'fontSize',
    'fills',
    'letterSpacing',
    'lineHeight',
    'textCase',
    'textDecoration',
  ]);
  const runs: IRTextRun[] = [];
  for (const s of segments) {
    const visibleFills = s.fills.filter((p) => p.visible !== false);
    const top = visibleFills[visibleFills.length - 1];
    let fill: IRSolidPaint | null = null;
    if (top?.type === 'SOLID') fill = await solid(top);
    else if (top) ctx.warnings.push(`${label(node)}: ${top.type} text fill is not supported yet`);

    const letterSpacing = s.letterSpacing.unit === 'PERCENT' ? (s.letterSpacing.value / 100) * s.fontSize : s.letterSpacing.value;
    const lineHeight =
      s.lineHeight.unit === 'AUTO' ? null : s.lineHeight.unit === 'PERCENT' ? (s.lineHeight.value / 100) * s.fontSize : s.lineHeight.value;

    runs.push({
      start: s.start,
      end: s.end,
      fontFamily: s.fontName.family,
      fontStyle: s.fontName.style,
      fontSize: s.fontSize,
      fill,
      letterSpacing,
      lineHeight,
      textCase: s.textCase,
      decoration: s.textDecoration,
    });
  }

  const m = node.absoluteTransform;
  const [x, y] = apply(m, 0, 0, ctx);
  return {
    ...base(node),
    type: 'text',
    characters: node.characters,
    rect: { x, y, w: node.width, h: node.height },
    matrix: [m[0][0], m[1][0], m[0][1], m[1][1]],
    autoResize: node.textAutoResize,
    alignH: node.textAlignHorizontal,
    alignV: node.textAlignVertical,
    paragraphSpacing: node.paragraphSpacing === figma.mixed ? 0 : node.paragraphSpacing,
    runs,
  };
}

function rectGeometry(m: Transform, w: number, h: number, ctx: Ctx): IRGeometry[] {
  const points = [apply(m, 0, 0, ctx), apply(m, w, 0, ctx), apply(m, w, h, ctx), apply(m, 0, h, ctx)].map(
    (p) => [p[0], p[1], p[0], p[1], p[0], p[1]] as IRPoint,
  );
  return [{ evenodd: false, subpaths: [{ closed: true, points }] }];
}

/** Geometry of a node, used both for drawing and for mask shapes. */
function shapeGeometry(node: SceneNode, ctx: Ctx): IRGeometry[] | null {
  const m = node.absoluteTransform;
  if (node.type === 'GROUP') {
    const parts = node.children.flatMap((c) => shapeGeometry(c, ctx) ?? []);
    return parts.length ? parts : null;
  }
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    return node.fills !== figma.mixed && node.fills.length ? rectGeometry(m, node.width, node.height, ctx) : null;
  }
  if (node.type === 'VECTOR') return geometryFrom(node.vectorPaths, m, ctx);
  if (node.type === 'LINE') {
    const a = apply(m, 0, 0, ctx);
    const b = apply(m, node.width, 0, ctx);
    return [{ evenodd: false, subpaths: [{ closed: false, points: [[...a, ...a, ...a], [...b, ...b, ...b]] as IRPoint[] }] }];
  }
  if ('fillGeometry' in node && node.fillGeometry.length) return geometryFrom(node.fillGeometry, m, ctx);
  if ('strokeGeometry' in node && node.strokeGeometry.length) return geometryFrom(node.strokeGeometry, m, ctx);
  return null;
}

async function serializeNode(node: SceneNode, ctx: Ctx): Promise<IRNode | null> {
  warnEffects(node, ctx);
  const m = node.absoluteTransform;

  switch (node.type) {
    case 'SLICE':
      return null;

    case 'TEXT':
      return serializeText(node, ctx);

    case 'FRAME':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION':
    case 'GROUP': {
      const group: IRGroupNode = {
        ...base(node),
        type: 'group',
        fills: node.type === 'GROUP' ? [] : await fillsOf(node, ctx),
        strokes: node.type === 'GROUP' ? [] : await strokesOf(node, ctx),
        children: await serializeChildren(node.children, ctx),
      };
      if (node.type !== 'GROUP') {
        const clip = 'clipsContent' in node ? node.clipsContent : false;
        group.frame = isAxisAligned(m)
          ? { rect: mappedRect(m, node.width, node.height, ctx), radii: radiiOf(node), clip }
          : { radii: [0, 0, 0, 0], geometry: rectGeometry(m, node.width, node.height, ctx), clip };
      }
      return group;
    }

    case 'RECTANGLE':
      if (isAxisAligned(m)) {
        return {
          ...base(node),
          type: 'rect',
          rect: mappedRect(m, node.width, node.height, ctx),
          radii: radiiOf(node),
          fills: await fillsOf(node, ctx),
          strokes: await strokesOf(node, ctx),
        };
      }
    // falls through for rotated rectangles
    case 'VECTOR':
    case 'LINE':
    case 'ELLIPSE':
    case 'POLYGON':
    case 'STAR':
    case 'BOOLEAN_OPERATION': {
      const geometry = shapeGeometry(node, ctx);
      if (!geometry) {
        ctx.warnings.push(`${label(node)}: no geometry, skipped`);
        return null;
      }
      return {
        ...base(node),
        type: 'path',
        geometry,
        fills: await fillsOf(node, ctx),
        strokes: await strokesOf(node, ctx),
      };
    }

    default:
      ctx.warnings.push(`${label(node)}: node type not supported, skipped`);
      return null;
  }
}

function invert2x3(t: Transform): Transform {
  const [a, b, tx] = t[0];
  const [c, d, ty] = t[1];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return t;
  return [
    [d / det, -b / det, (b * ty - d * tx) / det],
    [-c / det, a / det, (c * tx - a * ty) / det],
  ];
}

function gradientPaint(p: GradientPaint, node: SceneNode & LayoutMixin, ctx: Ctx): IRGradientPaint | IRSolidPaint {
  const mid = p.gradientStops[Math.floor(p.gradientStops.length / 2)];
  const solid = (): IRSolidPaint => ({
    type: 'solid',
    color: mid ? { r: mid.color.r, g: mid.color.g, b: mid.color.b } : { r: 0, g: 0, b: 0 },
    opacity: (p.opacity ?? 1) * (mid?.color.a ?? 1),
  });
  if (!p.gradientStops.length) return solid();
  if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
    ctx.warnings.push(`${label(node)}: ${p.type} approximated as solid color`);
    return solid();
  }
  const inv = invert2x3(p.gradientTransform);
  const local = (u: number, v: number): Vec => [
    (inv[0][0] * u + inv[0][1] * v + inv[0][2]) * node.width,
    (inv[1][0] * u + inv[1][1] * v + inv[1][2]) * node.height,
  ];
  const radial = p.type === 'GRADIENT_RADIAL';
  const start = radial ? local(0.5, 0.5) : local(0, 0.5);
  const end = local(1, 0.5);
  const m = node.absoluteTransform;
  return {
    type: radial ? 'radial' : 'linear',
    opacity: p.opacity ?? 1,
    from: apply(m, start[0], start[1], ctx),
    to: apply(m, end[0], end[1], ctx),
    stops: p.gradientStops.map((s) => ({
      position: s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b },
      opacity: (s.color.a ?? 1) * (p.opacity ?? 1),
    })),
  };
}

async function loadFontsFor(nodes: readonly SceneNode[]) {
  const seen = new Map<string, FontName>();
  const walk = (n: SceneNode) => {
    if (n.type === 'TEXT' && n.characters.length) {
      try {
        for (const font of n.getRangeAllFontNames(0, n.characters.length)) {
          seen.set(`${font.family}__${font.style}`, font);
        }
      } catch {
        /* unused or unloaded text */
      }
    }
    if ('children' in n) for (const child of n.children) walk(child);
  };
  for (const node of nodes) walk(node);
  await Promise.all([...seen.values()].map((font) => figma.loadFontAsync(font).catch(() => {})));
}

/** Gradient alpha of an ALPHA mask, in artboard space. VECTOR / opaque masks return null. */
function opacityMaskOf(node: SceneNode, ctx: Ctx): IROpacityMask | null {
  if (!('maskType' in node) || node.maskType !== 'ALPHA') return null;
  if (!('fills' in node) || node.fills === figma.mixed) return null;
  const fills = node.fills.filter((p) => p.visible !== false);
  if (fills.length !== 1 || !('gradientStops' in fills[0])) return null;
  const g = fills[0];
  const stops = g.gradientStops.map((s) => ({ position: s.position, opacity: (s.color.a ?? 1) * (g.opacity ?? 1) }));
  if (stops.every((s) => s.opacity > 0.99)) return null;
  const inv = invert2x3(g.gradientTransform);
  const local = (u: number, v: number): Vec => [
    (inv[0][0] * u + inv[0][1] * v + inv[0][2]) * node.width,
    (inv[1][0] * u + inv[1][1] * v + inv[1][2]) * node.height,
  ];
  const s = local(0, 0.5);
  const e = local(1, 0.5);
  const m = node.absoluteTransform;
  if (!ctx.reveal) ctx.warnings.push(`${label(node)}: fade has no solid color behind it — overlay may be missing`);
  return { from: apply(m, s[0], s[1], ctx), to: apply(m, e[0], e[1], ctx), stops, reveal: ctx.reveal };
}

function solidFillOf(node: IRNode): IRSolidPaint | null {
  if (node.type !== 'rect' && node.type !== 'path') return null;
  if (node.strokes.length || node.fills.length !== 1 || node.fills[0].type !== 'solid') return null;
  return node.fills[0];
}

/** Serializes children, wrapping a mask layer and everything above it into a clipped group. */
async function serializeChildren(children: readonly SceneNode[], ctx: Ctx): Promise<IRNode[]> {
  const out: IRNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if ('visible' in child && !child.visible && !('isMask' in child && child.isMask)) continue;
    if ('isMask' in child && child.isMask) {
      const clip = shapeGeometry(child, ctx);
      const fade = opacityMaskOf(child, ctx);
      if (!clip && !fade) {
        ctx.warnings.push(`${label(child)}: mask without geometry ignored`);
        continue;
      }
      const rest = await serializeChildren(children.slice(i + 1), ctx);
      // QR-style masks: a solid swatch clipped to many dots is just those dots in that color.
      if (!fade && clip && rest.length === 1) {
        const paint = solidFillOf(rest[0]);
        if (paint) {
          out.push({ ...base(child), name: child.name, type: 'path', geometry: clip, fills: [paint], strokes: [] });
          break;
        }
      }
      out.push({
        ...base(child),
        name: `${child.name} (mask)`,
        type: 'group',
        fills: [],
        strokes: [],
        children: rest,
        clipGeometry: clip ?? undefined,
        opacityMask: fade ?? undefined,
      });
      break;
    }
    const ir = await serializeNode(child, ctx);
    if (ir) out.push(ir);
  }
  return out;
}

const TRIMBOX = /^trim\s*box$/i;

export type ExportFrame = FrameNode | ComponentNode | InstanceNode;

export async function serializeSelection(frames: readonly ExportFrame[], options: BuildOptions): Promise<{ doc: IRDocument; assets: Asset[] }> {
  await loadFontsFor(frames);
  const ox = Math.min(...frames.map((f) => f.absoluteTransform[0][2]));
  const oy = Math.min(...frames.map((f) => f.absoluteTransform[1][2]));
  const ctx: Ctx = { ox, oy, warnings: [], assets: new Map(), ppi: options.ppi ?? 300 };

  const artboards: IRArtboard[] = [];
  for (const frame of frames) {
    const m = frame.absoluteTransform;
    if (!isAxisAligned(m)) ctx.warnings.push(`${label(frame)}: rotated frame exported unrotated`);
    const rect = mappedRect(m, frame.width, frame.height, ctx);

    let trim = rect;
    let children: readonly SceneNode[] = frame.children;
    const slice = frame.children.find((c) => c.type === 'SLICE' && TRIMBOX.test(c.name));
    if (options.trimboxFromSlice && slice) {
      trim = mappedRect(slice.absoluteTransform, slice.width, slice.height, ctx);
      children = frame.children.filter((c) => c !== slice);
    }

    const fills = await fillsOf(frame, ctx);
    ctx.reveal = fills.find((p): p is IRSolidPaint => p.type === 'solid');
    artboards.push({
      id: frame.id,
      name: frame.name,
      rect,
      trim,
      clip: frame.clipsContent,
      fills,
      children: await serializeChildren(children, ctx),
    });
    ctx.reveal = undefined;
  }

  return {
    doc: {
      irVersion: IR_VERSION,
      source: { fileName: figma.root.name, pageName: figma.currentPage.name },
      options,
      artboards,
      warnings: ctx.warnings,
    },
    assets: [...ctx.assets.values()],
  };
}
