// Bundled for use_figma: serializes frames by id without shipping image bytes.
import type { BuildOptions } from '@f2a/schema';
import { serializeSelection, type ExportFrame } from '../packages/figma-plugin/src/serialize';

(globalThis as unknown as { __f2a: unknown }).__f2a = async (ids: string[], options: BuildOptions) => {
  const frames = (await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)))) as ExportFrame[];
  const { doc, assets } = await serializeSelection(frames, options);
  return { doc, assets: assets.map((a) => ({ ref: a.ref, size: a.bytes.length })) };
};
