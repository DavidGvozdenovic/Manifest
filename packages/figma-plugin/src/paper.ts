/** ISO 216 A and B series (trim, mm). Either orientation matches. */

export type PaperId = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'B0' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6';
export type Ppi = 72 | 150 | 300;

export interface PaperSize {
  id: PaperId;
  w: number;
  h: number;
}

export const PAPERS: PaperSize[] = [
  { id: 'A0', w: 841, h: 1189 },
  { id: 'A1', w: 594, h: 841 },
  { id: 'A2', w: 420, h: 594 },
  { id: 'A3', w: 297, h: 420 },
  { id: 'A4', w: 210, h: 297 },
  { id: 'A5', w: 148, h: 210 },
  { id: 'A6', w: 105, h: 148 },
  { id: 'B0', w: 1000, h: 1414 },
  { id: 'B1', w: 707, h: 1000 },
  { id: 'B2', w: 500, h: 707 },
  { id: 'B3', w: 353, h: 500 },
  { id: 'B4', w: 250, h: 353 },
  { id: 'B5', w: 176, h: 250 },
  { id: 'B6', w: 125, h: 176 },
];

const PT_PER_MM = 72 / 25.4;
/** ±1.5 mm covers Figma rounding and 3 mm bleed leftover on the frame. */
const TOL_MM = 1.5;

export function ptToMm(pt: number) {
  return (pt / PT_PER_MM) * 1;
}

export function mmToPt(mm: number) {
  return mm * PT_PER_MM;
}

function sameSize(a: number, b: number, c: number, d: number) {
  return (Math.abs(a - c) <= TOL_MM && Math.abs(b - d) <= TOL_MM) || (Math.abs(a - d) <= TOL_MM && Math.abs(b - c) <= TOL_MM);
}

export function detectPaper(wMm: number, hMm: number): PaperSize | null {
  return PAPERS.find((p) => sameSize(wMm, hMm, p.w, p.h)) ?? null;
}

export function paperById(id: string): PaperSize | null {
  return PAPERS.find((p) => p.id === id) ?? null;
}

export function formatMm(w: number, h: number) {
  const a = Math.round(w * 10) / 10;
  const b = Math.round(h * 10) / 10;
  return `${a} × ${b} mm`;
}

/**
 * Print PPI: 300 for anything read up close, 150 for large format seen from a metre or more.
 * 72 is only a screen proof — never the default for print.
 */
export type PpiKind = 'large' | 'close';

export function recommendPpi(wMm: number, hMm: number): { ppi: Ppi; kind: PpiKind } {
  const long = Math.max(wMm, hMm);
  const short = Math.min(wMm, hMm);
  if (long >= 500 || short >= 400) return { ppi: 150, kind: 'large' };
  return { ppi: 300, kind: 'close' };
}

export interface PageMeasure {
  name: string;
  wMm: number;
  hMm: number;
  fromTrim: boolean;
  paper: PaperId | null;
}
