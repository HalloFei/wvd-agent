import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { findQuickHeal, QUICK_HEAL_FLOOR } from '../src/perception/quick-heal.ts';

const load = async (name: string): Promise<RgbaImage> => {
  const bytes = await readFile(new URL('../testdata/screens/2026-11-09-heal/' + name, import.meta.url));
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: image.width, height: image.height, data: image.data };
};

describe('the 一键恢复 dialog', () => {
  it('names the live dialog, at the 恢复 button the reader matched', async () => {
    const found = findQuickHeal(await load('quick-heal-1920.jpg'));
    expect(found).not.toBeNull();
    if (found === null) return;
    expect(found.score).toBeGreaterThanOrEqual(QUICK_HEAL_FLOOR);
    // The dialog's right-hand button, measured live 2026-11-09; the old fixed (1070,813) is 36 px low.
    expect(Math.abs(found.at.x - 1_087)).toBeLessThanOrEqual(6);
    expect(Math.abs(found.at.y - 802)).toBeLessThanOrEqual(6);
    expect(found.cancel.x).toBeLessThan(found.at.x);
  });

  it('does not name the character page the dialog is drawn over', async () => {
    // The page's X 关闭 tile stays visible below the panel: only the two button plates together are
    // the dialog's evidence, and the page frame has neither.
    expect(findQuickHeal(await load('page-1920.jpg'))).toBeNull();
    expect(findQuickHeal(await load('quick-heal-result-1920.jpg'))).toBeNull();
  });
});
