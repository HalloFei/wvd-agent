import { describe, expect, it } from 'vitest';
import type { PixelRect, RgbaImage } from '../src/contracts.ts';
import type { LocationEntry } from '../src/perception/locations.ts';
import type { MatchTemplate } from '../src/perception/match.ts';
import { findSite, findSites } from '../src/perception/site-finder.ts';

/**
 * The finder is location- and size-invariant by construction, so its test is too: a synthetic frame
 * with a known icon and its title at a known place, at two scales, and nothing else. What is being
 * proved is the *pair* rule — an icon alone is not a site once the title is asked for.
 */
const STRIP: PixelRect = { x: 480, y: 0, width: 960, height: 1_080 };

/**
 * Two art forms that cannot be mistaken for one another — which is the point of the pair: an icon is
 * a node glyph, a title is a run of text-like bars. (A first cut used one ramp formula for both and
 * the icon matched *the title* at 0.93: a reminder that a test that cannot tell the two apart cannot
 * test the pair.)
 */
const ICON: MatchTemplate = {
  width: 40,
  height: 40,
  gray: (() => {
    const gray = new Uint8Array(40 * 40);
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 40; x += 1) {
        const distance = Math.hypot(x - 19.5, y - 19.5);
        gray[y * 40 + x] = Math.abs(distance - 12) <= 4 ? 220 : 40;
      }
    }
    return gray;
  })(),
};
const TITLE: MatchTemplate = {
  width: 160,
  height: 40,
  gray: (() => {
    const gray = new Uint8Array(160 * 40);
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 160; x += 1) {
        gray[y * 160 + x] = Math.floor(x / 12) % 2 === 0 ? 210 : 50;
      }
    }
    return gray;
  })(),
};

function frame(): RgbaImage {
  const width = 1_920;
  const height = 1_080;
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 90;
    data[index * 4 + 1] = 84;
    data[index * 4 + 2] = 70;
    data[index * 4 + 3] = 255;
  }
  return { data, width, height };
}

function stamp(image: RgbaImage, template: MatchTemplate, at: { x: number; y: number }): void {
  for (let y = 0; y < template.height; y += 1) {
    for (let x = 0; x < template.width; x += 1) {
      const value = template.gray[y * template.width + x]!;
      const to = ((at.y + y) * image.width + (at.x + x)) * 4;
      image.data[to] = value;
      image.data[to + 1] = value;
      image.data[to + 2] = value;
    }
  }
}

const ENTRY: LocationEntry = {
  id: 'test-site',
  label: '北穿幽冥城',
  kind: 'worldmap',
  template: ICON,
  labelBand: TITLE,
};

const AT = { x: 700, y: 400 };

function withSite(withTitle: boolean): RgbaImage {
  const image = frame();
  stamp(image, ICON, AT);
  if (withTitle) {
    // The title hangs below the icon, centred on it, a fixed rise below the icon's centre.
    // The title's *centre* hangs the rise below the icon's centre, so it must clear the icon's art:
    // a title stamped over the icon is a fixture bug, not a finder result.
    stamp(image, TITLE, {
      x: AT.x + 20 - Math.round(TITLE.width / 2),
      y: AT.y + 20 + 40 - Math.round(TITLE.height / 2),
    });
  }
  return image;
}

describe('the site finder', () => {
  it('finds the icon where it is drawn, with no other site in the frame', () => {
    const found = findSite(withSite(false), ENTRY, { strip: STRIP, iconScales: [1], wantTitle: false });
    expect(found).not.toBeNull();
    expect(Math.abs(found!.point.x - (AT.x + 20))).toBeLessThanOrEqual(4);
    expect(Math.abs(found!.point.y - (AT.y + 20))).toBeLessThanOrEqual(4);
    expect(found!.iconScore).toBeGreaterThan(0.9);
    expect(found!.titleScore).toBeNull();
  });

  it('requires its own title, and not a bright frame', () => {
    const found = findSite(withSite(true), ENTRY, { strip: STRIP, iconScales: [1], titleScales: [1] });
    expect(found).not.toBeNull();
    expect(found!.titleScore).toBeGreaterThan(0.8);
    expect(found!.confidence).toBeGreaterThan(0.85);

    // The icon alone, with the title asked for: that is not the pair.
    expect(findSite(withSite(false), ENTRY, { strip: STRIP, iconScales: [1], titleScales: [1] })).toBeNull();
    // And a frame with no icon at all is not the site, whatever its title.
    expect(findSite(frame(), ENTRY, { strip: STRIP, iconScales: [1], wantTitle: false })).toBeNull();
  });

  it('ranks the sites a frame shows, best first, without consulting another site', () => {
    const image = withSite(true);
    const other: LocationEntry = {
      ...ENTRY,
      id: 'other-site',
      label: '别处',
      template: { ...ICON, gray: ICON.gray.map((value) => 255 - value) },
    };
    const found = findSites(image, [other, ENTRY], { strip: STRIP, iconScales: [1], titleScales: [1] });
    expect(found.map((candidate) => candidate.id)).toEqual(['test-site']);
  });
});
