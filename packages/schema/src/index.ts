/**
 * F2A-IR: the JSON contract between the Figma plugin and the Illustrator builder.
 *
 * Coordinates are in points (1 Figma px = 1 pt), y grows downward, and are
 * relative to the export origin (top-left of the bounding box of all exported
 * frames). The Illustrator builder flips y.
 */

export const IR_VERSION = 1;

export interface IRDocument {
  irVersion: typeof IR_VERSION;
  source: { fileName: string; pageName: string };
  options: BuildOptions;
  artboards: IRArtboard[];
  warnings: string[];
}

export interface BuildOptions {
  colorMode: 'CMYK' | 'RGB';
  /** Use a child slice named "Trimbox" to derive trim size and bleed. */
  trimboxFromSlice: boolean;
  /** Document bleed in mm; null derives it from the Trimbox slice (or 0 without one). */
  bleedMm: number | null;
  /** ISO paper id, or `auto` to use the detected trim, or `custom` to keep Figma millimetres. */
  paperFormat: 'auto' | 'custom' | string;
  /** Document raster resolution in Illustrator. */
  ppi: 72 | 150 | 300;
  embedImages: boolean;
}

export type CMYK = [number, number, number, number];

export interface IRColor {
  r: number;
  g: number;
  b: number;
}

export interface IRSolidPaint {
  type: 'solid';
  color: IRColor;
  opacity: number;
  /** Figma style or variable name, used for swatches/spot colors. */
  swatch?: string;
  /** Print color chosen in the plugin (0–100); becomes a global swatch in CMYK documents. */
  cmyk?: CMYK;
  spot?: boolean;
}

export interface IRImagePaint {
  type: 'image';
  /** File name of the asset uploaded to the panel, e.g. "<hash>.jpg". */
  ref: string;
  opacity: number;
  /** Placement of the full image in artboard space, before clipping. */
  rect: IRRect;
  /** Unit-square corners in artboard space: top-left, top-right, bottom-left. */
  corners?: [[number, number], [number, number], [number, number]];
}

export interface IRGradientStop {
  position: number;
  color: IRColor;
  opacity: number;
  cmyk?: CMYK;
}

/** Linear / radial fill in artboard space. Angular and diamond stay approximated as solids. */
export interface IRGradientPaint {
  type: 'linear' | 'radial';
  opacity: number;
  from: [number, number];
  to: [number, number];
  stops: IRGradientStop[];
  swatch?: string;
}

export type IRPaint = IRSolidPaint | IRImagePaint | IRGradientPaint;

export interface IRStroke {
  paint: IRSolidPaint;
  weight: number;
  align: 'CENTER' | 'INSIDE' | 'OUTSIDE';
  cap: 'NONE' | 'ROUND' | 'SQUARE';
  join: 'MITER' | 'BEVEL' | 'ROUND';
  miterLimit: number;
  dashes: number[];
}

export interface IRRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cubic Bezier anchor: [ax, ay, inX, inY, outX, outY]. */
export type IRPoint = [number, number, number, number, number, number];

export interface IRSubpath {
  closed: boolean;
  points: IRPoint[];
}

export interface IRGeometry {
  evenodd: boolean;
  subpaths: IRSubpath[];
}

interface IRBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
}

/** Alpha fade from a Figma mask; overlay color is the solid revealed behind the photo. */
export interface IROpacityMask {
  from: [number, number];
  to: [number, number];
  stops: { position: number; opacity: number }[];
  reveal?: IRSolidPaint;
}

export interface IRGroupNode extends IRBase {
  type: 'group';
  /** Frame background and clip shape; absent for plain groups. Rotated frames use geometry instead of rect. */
  frame?: { rect?: IRRect; radii: [number, number, number, number]; geometry?: IRGeometry[]; clip: boolean };
  /** Clip shape from a Figma mask layer. */
  clipGeometry?: IRGeometry[];
  /** Gradient alpha mask (photo fade). Built as an editable overlay in the reveal color. */
  opacityMask?: IROpacityMask;
  fills: IRPaint[];
  strokes: IRStroke[];
  children: IRNode[];
}

export interface IRRectNode extends IRBase {
  type: 'rect';
  rect: IRRect;
  radii: [number, number, number, number];
  fills: IRPaint[];
  strokes: IRStroke[];
}

export interface IRPathNode extends IRBase {
  type: 'path';
  geometry: IRGeometry[];
  fills: IRPaint[];
  strokes: IRStroke[];
}

export interface IRTextRun {
  start: number;
  end: number;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  fill: IRSolidPaint | null;
  /** Points. */
  letterSpacing: number;
  /** Points; null means auto. */
  lineHeight: number | null;
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
}

export interface IRTextNode extends IRBase {
  type: 'text';
  characters: string;
  rect: IRRect;
  /** 2x2 rotation/skew part of the transform; identity when not rotated. */
  matrix: [number, number, number, number];
  autoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  alignH: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  alignV: 'TOP' | 'CENTER' | 'BOTTOM';
  paragraphSpacing: number;
  runs: IRTextRun[];
}

export type IRNode = IRGroupNode | IRRectNode | IRPathNode | IRTextNode;

export interface IRArtboard {
  id: string;
  name: string;
  rect: IRRect;
  /** Trim box; equals rect when there is no bleed. */
  trim: IRRect;
  /** Clip content to rect, so overflow does not spill onto neighbouring artboards. */
  clip: boolean;
  fills: IRPaint[];
  children: IRNode[];
}
