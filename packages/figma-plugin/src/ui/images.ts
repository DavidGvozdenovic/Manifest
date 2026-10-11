import type { IRDocument, IRNode, IRPaint } from '@f2a/schema';

export interface Asset {
  ref: string;
  bytes: Uint8Array;
}

export interface ResizeNote {
  ref: string;
  from: [number, number];
  to: [number, number];
  ppi: number;
  scaled: 'down' | 'up' | 'same';
  bytesIn: number;
  bytesOut: number;
  failed?: boolean;
}

function walkPaints(doc: IRDocument, fn: (p: IRPaint) => void) {
  const visit = (n: IRNode) => {
    if (n.type === 'text') return;
    n.fills.forEach(fn);
    if (n.type === 'group') n.children.forEach(visit);
  };
  for (const ab of doc.artboards) {
    ab.fills.forEach(fn);
    ab.children.forEach(visit);
  }
}

/** Largest placed size per asset, in pixels at the chosen PPI. */
export function pixelTargets(doc: IRDocument, ppi: number): Map<string, { w: number; h: number }> {
  const map = new Map<string, { w: number; h: number }>();
  walkPaints(doc, (p) => {
    if (p.type !== 'image') return;
    const w = (p.rect.w / 72) * ppi;
    const h = (p.rect.h / 72) * ppi;
    const prev = map.get(p.ref);
    if (!prev) map.set(p.ref, { w, h });
    else map.set(p.ref, { w: Math.max(prev.w, w), h: Math.max(prev.h, h) });
  });
  return map;
}

function mimeOf(ref: string) {
  if (ref.endsWith('.png')) return 'image/png';
  if (ref.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

async function decode(bytes: Uint8Array) {
  return createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
}

async function encode(canvas: HTMLCanvasElement, mime: string): Promise<Uint8Array> {
  const type = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (!blob) throw new Error('resize encode failed');
  return new Uint8Array(await blob.arrayBuffer());
}

const SLACK = 0.05;

/**
 * Resizes each asset so its pixels match the placed size at `ppi`.
 * Larger photos are downsampled; smaller ones are upscaled (may look soft).
 */
export async function fitAssetsToPpi(doc: IRDocument, assets: Asset[], ppi: number): Promise<ResizeNote[]> {
  const targets = pixelTargets(doc, ppi);
  const notes: ResizeNote[] = [];
  for (const asset of assets) {
    const need = targets.get(asset.ref);
    if (!need) continue;
    const tw = Math.max(1, Math.round(need.w));
    const th = Math.max(1, Math.round(need.h));
    let bmp: ImageBitmap;
    try {
      bmp = await decode(asset.bytes);
    } catch {
      notes.push({ ref: asset.ref, from: [0, 0], to: [tw, th], ppi, scaled: 'same', bytesIn: asset.bytes.length, bytesOut: asset.bytes.length });
      continue;
    }
    const close = Math.abs(bmp.width / tw - 1) <= SLACK && Math.abs(bmp.height / th - 1) <= SLACK;
    if (close) {
      notes.push({ ref: asset.ref, from: [bmp.width, bmp.height], to: [bmp.width, bmp.height], ppi, scaled: 'same', bytesIn: asset.bytes.length, bytesOut: asset.bytes.length });
      bmp.close();
      continue;
    }
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      notes.push({
        ref: asset.ref,
        from: [bmp.width, bmp.height],
        to: [tw, th],
        ppi,
        scaled: 'same',
        bytesIn: asset.bytes.length,
        bytesOut: asset.bytes.length,
        failed: true,
      });
      bmp.close();
      continue;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, tw, th);
    const out = await encode(canvas, mimeOf(asset.ref));
    const scaled: ResizeNote['scaled'] = tw * th < bmp.width * bmp.height ? 'down' : 'up';
    notes.push({ ref: asset.ref, from: [bmp.width, bmp.height], to: [tw, th], ppi, scaled, bytesIn: asset.bytes.length, bytesOut: out.length });
    asset.bytes = out;
    bmp.close();
  }
  return notes;
}

export function resizeLine(n: ResizeNote) {
  const mb = (size: number) => (size / 1e6).toFixed(1);
  if (n.failed) return `${n.ref}: could not resize — original pixels sent`;
  if (n.scaled === 'same') return `${n.from[0]}×${n.from[1]} px · ${n.ppi} PPI`;
  const verb = n.scaled === 'down' ? 'downsampled' : 'upscaled';
  const soft = n.scaled === 'up' ? ' ⚠ may look soft' : '';
  return `${verb} ${n.from[0]}×${n.from[1]} → ${n.to[0]}×${n.to[1]} px (${n.ppi} PPI, ${mb(n.bytesIn)}→${mb(n.bytesOut)} MB)${soft}`;
}
