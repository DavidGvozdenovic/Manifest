import type { CMYK, IRColor, IRDocument, IRNode, IRPaint, IRSolidPaint } from '@f2a/schema';

export interface ColorUse {
  hex: string;
  names: string[];
  count: number;
}

/** User's choice for one Figma hex; missing fields fall back to the automatic conversion. */
export interface ColorOverride {
  cmyk?: CMYK;
  spot?: boolean;
  name?: string;
}

/** Conversions computed by Illustrator with its color settings; de values are CIEDE2000. */
export interface AutoColor {
  hex: string;
  /** Closest printable CMYK found by search. */
  cmyk: CMYK;
  de: number;
  /** Illustrator's own ICC conversion. */
  icc: CMYK;
  iccDe: number;
  gray: number;
  proof: string;
}

export type AutoMethod = 'closest' | 'icc';

function hex2(v: number) {
  return Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
}

export function hexOf(c: IRColor) {
  return `#${hex2(c.r * 255)}${hex2(c.g * 255)}${hex2(c.b * 255)}`;
}

function asSolid(p: IRPaint): IRSolidPaint[] {
  if (p.type === 'solid') return [p];
  if (p.type === 'linear' || p.type === 'radial') {
    return p.stops.map((s) => ({ type: 'solid' as const, color: s.color, opacity: s.opacity, cmyk: s.cmyk, swatch: p.swatch }));
  }
  return [];
}

function forEachPaint(doc: IRDocument, fn: (p: IRSolidPaint) => void) {
  const paints = (list: IRPaint[]) => list.forEach((p) => asSolid(p).forEach(fn));
  const visit = (n: IRNode) => {
    if (n.type === 'text') {
      n.runs.forEach((r) => r.fill && fn(r.fill));
      return;
    }
    paints(n.fills);
    n.strokes.forEach((s) => fn(s.paint));
    if (n.type === 'group') {
      if (n.opacityMask?.reveal) fn(n.opacityMask.reveal);
      n.children.forEach(visit);
    }
  };
  for (const ab of doc.artboards) {
    paints(ab.fills);
    ab.children.forEach(visit);
  }
}

export function collectColors(doc: IRDocument): ColorUse[] {
  const map = new Map<string, ColorUse>();
  forEachPaint(doc, (p) => {
    const hex = hexOf(p.color);
    let use = map.get(hex);
    if (!use) map.set(hex, (use = { hex, names: [], count: 0 }));
    use.count++;
    if (p.swatch && !use.names.includes(p.swatch)) use.names.push(p.swatch);
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function isNeutral(hex: string) {
  const [r, g, b] = rgbOf(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 2;
}

/** Automatic print color; neutrals optionally go on the K plate only. */
export function autoCmyk(auto: AutoColor, neutralsToK: boolean, method: AutoMethod): CMYK {
  if (neutralsToK && isNeutral(auto.hex)) return [0, 0, 0, Math.round(auto.gray)];
  return method === 'icc' ? auto.icc : auto.cmyk;
}

export function applyColors(doc: IRDocument, choice: (hex: string) => { cmyk?: CMYK; spot?: boolean; name?: string }): IRDocument {
  const out: IRDocument = structuredClone(doc);
  const paintLists = (list: IRPaint[]) => {
    for (const p of list) {
      if (p.type === 'solid') {
        const c = choice(hexOf(p.color));
        p.cmyk = c.cmyk;
        if (c.spot !== undefined) p.spot = c.spot;
        if (c.name) p.swatch = c.name;
      } else if (p.type === 'linear' || p.type === 'radial') {
        if (p.swatch) {
          const named = choice(hexOf(p.stops[0]?.color ?? { r: 0, g: 0, b: 0 }));
          if (named.name) p.swatch = named.name;
        }
        for (const s of p.stops) s.cmyk = choice(hexOf(s.color)).cmyk;
      }
    }
  };
  const visit = (n: IRNode) => {
    if (n.type === 'text') {
      n.runs.forEach((r) => {
        if (!r.fill) return;
        const c = choice(hexOf(r.fill.color));
        r.fill.cmyk = c.cmyk;
        if (c.spot !== undefined) r.fill.spot = c.spot;
        if (c.name) r.fill.swatch = c.name;
      });
      return;
    }
    paintLists(n.fills);
    n.strokes.forEach((s) => {
      const c = choice(hexOf(s.paint.color));
      s.paint.cmyk = c.cmyk;
      if (c.spot !== undefined) s.paint.spot = c.spot;
      if (c.name) s.paint.swatch = c.name;
    });
    if (n.type === 'group') {
      if (n.opacityMask?.reveal) {
        const c = choice(hexOf(n.opacityMask.reveal.color));
        n.opacityMask.reveal.cmyk = c.cmyk;
        if (c.spot !== undefined) n.opacityMask.reveal.spot = c.spot;
        if (c.name) n.opacityMask.reveal.swatch = c.name;
      }
      n.children.forEach(visit);
    }
  };
  for (const ab of out.artboards) {
    paintLists(ab.fills);
    ab.children.forEach(visit);
  }
  return out;
}

function rgbOf(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
