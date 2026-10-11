import type { BuildOptions } from '@f2a/schema';
import { detectPaper, ptToMm, type PageMeasure } from './paper';
import { serializeSelection, type ExportFrame } from './serialize';

figma.showUI(__html__, { width: 460, height: 720, themeColors: true });

const SETTINGS_KEY = 'f2a.settings';
const TRIMBOX = /^trim\s*box$/i;

type UIMessage =
  | { type: 'ready' }
  | { type: 'export'; options: BuildOptions }
  | { type: 'save-settings'; settings: unknown };

let trimboxFromSlice = true;

function selectedFrames(): ExportFrame[] {
  return figma.currentPage.selection.filter(
    (n): n is ExportFrame => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE',
  );
}

function readTrimboxFlag(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const options = (value as { options?: { trimboxFromSlice?: unknown } }).options;
  if (typeof options?.trimboxFromSlice === 'boolean') trimboxFromSlice = options.trimboxFromSlice;
}

function measureFrame(frame: ExportFrame): PageMeasure {
  const slice = frame.children.find((c) => c.type === 'SLICE' && TRIMBOX.test(c.name));
  const use = trimboxFromSlice && slice ? slice : null;
  const w = use ? use.width : frame.width;
  const h = use ? use.height : frame.height;
  const wMm = ptToMm(w);
  const hMm = ptToMm(h);
  return { name: frame.name, wMm, hMm, fromTrim: !!use, paper: detectPaper(wMm, hMm)?.id ?? null };
}

function postSelection() {
  const frames = selectedFrames();
  figma.ui.postMessage({
    type: 'selection',
    count: frames.length,
    names: frames.slice(0, 5).map((f) => f.name),
    pages: frames.slice(0, 8).map(measureFrame),
  });
}

figma.on('selectionchange', postSelection);

figma.ui.onmessage = async (msg: UIMessage) => {
  if (msg.type === 'ready') {
    const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) ?? null;
    readTrimboxFlag(stored);
    figma.ui.postMessage({ type: 'settings', settings: stored });
    postSelection();
    return;
  }
  if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
    readTrimboxFlag(msg.settings);
    postSelection();
    return;
  }
  if (msg.type !== 'export') return;
  trimboxFromSlice = msg.options.trimboxFromSlice;
  const frames = selectedFrames();
  if (!frames.length) {
    figma.ui.postMessage({ type: 'error', message: 'Select at least one frame.' });
    return;
  }
  try {
    const { doc, assets } = await serializeSelection(frames, msg.options);
    figma.ui.postMessage({ type: 'payload', doc, assets });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
