/**
 * The chest opener panel `由谁打开?` (Task 12), read from `testdata/chest/2026-10-24-opener/`.
 *
 * The fixture is **one live panel**: `panel-00.jpg` and `panel-01.jpg` are two captures of the same
 * screen, and `measurements.json` is the operator's reading of it. The expected 陷阱发现 / 陷阱解除
 * numbers are loaded from that JSON, not re-typed here, so the test cannot disagree with the
 * measurement it is testing. The 心 (willpower) column is **not** in the JSON: it was read off the
 * heart numerals in the captures, and the one card that draws no heart (DragonSlayer) is documented
 * in `parseOpener`'s header.
 *
 * Negative controls are the frames that have been mistaken for things before: the QTE bar, the 3-D
 * view, and `after-pick.jpg` — the same chest once the panel was dismissed.
 */
import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { WVD_DEFAULTS } from '../src/config.ts';
import type { Frame, OpenerMember, OpenerPanel, RgbaImage } from '../src/contracts.ts';
import { ChestPerceiver, openerCardCentre, parseOpener } from '../src/perception/chest.ts';
import { chooseOpener, WILLPOWER_FLOOR } from '../src/policy/chest.ts';

const FIXTURES = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const MEASUREMENTS = new URL('measurements.json', FIXTURES);
/** The QTE bar (2026-10-24 01:41): a real frame with no panel on it. */
const QTE_FIXTURES = new URL('../testdata/chest/2026-10-24-qte-0141/', import.meta.url);
/** The 3-D view: HUD and map, no modal panel. */
const NAV_FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Decoded once per fixture: `jpeg-js` spends ~150 ms on a 1080p frame and the tests share them. */
const imageCache = new Map<string, Promise<RgbaImage>>();

function jpegImage(name: string, dir = FIXTURES): Promise<RgbaImage> {
  const key = `${dir.href}${name}`;
  let image = imageCache.get(key);
  if (!image) {
    image = readFile(new URL(name, dir)).then((bytes) => {
      const decoded = jpeg.decode(bytes, { useTArray: true });
      return { data: decoded.data, width: decoded.width, height: decoded.height };
    });
    imageCache.set(key, image);
  }
  return image;
}

function frameOf(image: RgbaImage, atMs: number): Frame {
  return { atMs, width: image.width, height: image.height, toRgba: async () => image };
}

async function jpegFrame(name: string, atMs = 1_000, dir = FIXTURES): Promise<Frame> {
  return frameOf(await jpegImage(name, dir), atMs);
}

function copyOf(image: RgbaImage): RgbaImage {
  return { data: Uint8Array.from(image.data), width: image.width, height: image.height };
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function paint(image: RgbaImage, rect: Rect, rgb: readonly [number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
      image.data[offset + 3] = 255;
    }
  }
}

/** What `measurements.json` says the six cards carry. */
interface MeasuredMember {
  readonly name: string;
  readonly detect: number;
  readonly disarm: number;
}

let measuredMembers: Promise<readonly MeasuredMember[]> | null = null;
function measured(): Promise<readonly MeasuredMember[]> {
  measuredMembers ??= readFile(MEASUREMENTS, 'utf8').then(
    (text) => (JSON.parse(text) as { members: MeasuredMember[] }).members,
  );
  return measuredMembers;
}

/**
 * The heart numerals, read off `panel-00.jpg`: 艾莉賽, 本杰明 and 拉纳维尔 at 100, 爱丽丝 at 90,
 * 薇薇安娜DEX6 at 100. **DragonSlayer draws no heart at all** — the game omits the numeral for that
 * member, and `parseOpener` documents the conservative default it uses instead (the panel's highest
 * displayed heart, which is 100 here).
 */
const WILLPOWER = [100, 100, 100, 100, 90, 100] as const;

// ---------------------------------------------------------------------------------------------
// parseOpener — the fixture
// ---------------------------------------------------------------------------------------------

describe('parseOpener — the 由谁打开? panel', () => {
  it('reads the six cards in the order the panel draws them', async () => {
    const expected = await measured();
    const panel = await parseOpener(await jpegFrame('panel-00.jpg', 7_654));

    expect(panel).not.toBeNull();
    expect(panel!.members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
    expect(panel!.members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
  });

  it('names the members by position, because the names are CJK and cannot be read', async () => {
    const panel = await parseOpener(await jpegFrame('panel-00.jpg'));

    // 1-based, in card order: the name is the one field the panel shows as text and the parser
    // cannot OCR, so the loop addresses a member by the card it sits on instead.
    expect(panel!.members.map((member) => member.name)).toEqual(['#1', '#2', '#3', '#4', '#5', '#6']);
  });

  it('reads the heart numeral as willpower, and takes no heart as "not displayed"', async () => {
    const panel = await parseOpener(await jpegFrame('panel-00.jpg'));

    expect(panel!.members.map((member) => member.willpower)).toEqual([...WILLPOWER]);
    // DragonSlayer (card 4) is the one card with no heart: the numeral is absent from the screen,
    // not unreadable, and the closed contract has no "unknown". The parser fills it with the highest
    // heart the same panel displays — a bound the panel itself proves, never a standalone guess.
    expect(panel!.members[3]!.willpower).toBe(Math.max(WILLPOWER[0], WILLPOWER[1], WILLPOWER[2], WILLPOWER[4], WILLPOWER[5]));
  });

  it('never claims a member is feared: 陷阱恐惧 is not shown in this fixture', async () => {
    const panel = await parseOpener(await jpegFrame('panel-00.jpg'));

    expect(panel!.members.map((member) => member.feared)).toEqual([false, false, false, false, false, false]);
  });

  it('reads the same panel from the second capture', async () => {
    const expected = await measured();
    const panel = await parseOpener(await jpegFrame('panel-01.jpg'));

    expect(panel!.members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
    expect(panel!.members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
    expect(panel!.members.map((member) => member.willpower)).toEqual([...WILLPOWER]);
  });

  it('segments the cards instead of assuming six: a party of three ends after the first row', async () => {
    const image = copyOf(await jpegImage('panel-00.jpg'));
    // Erase the second row the way the game would simply not draw it: no cards, no card borders.
    paint(image, { x: 700, y: 842, w: 540, h: 143 }, [35, 35, 35]);

    const panel = await parseOpener(frameOf(image, 1_000));
    const expected = await measured();
    expect(panel!.members.map((member) => member.detect)).toEqual(expected.slice(0, 3).map((member) => member.detect));
    expect(panel!.members.map((member) => member.disarm)).toEqual(expected.slice(0, 3).map((member) => member.disarm));
  });

  it('refuses the whole panel when one digit is unreadable, rather than guessing it', async () => {
    // 艾莉賽's 陷阱发现 38: overpaint the 8 with bright ink that is not any digit. The glyph is still
    // one atom; its feature matches nothing above the floor, and the panel is refused.
    const overpainted = copyOf(await jpegImage('panel-00.jpg'));
    paint(overpainted, { x: 788, y: 794, w: 10, h: 15 }, [235, 235, 235]);
    expect(await parseOpener(frameOf(overpainted, 1_000))).toBeNull();

    // Ink that is not any digit: a solid block across a whole number reads nothing either.
    const blob = copyOf(await jpegImage('panel-00.jpg'));
    paint(blob, { x: 955, y: 794, w: 20, h: 14 }, [235, 235, 235]);
    expect(await parseOpener(frameOf(blob, 1_000))).toBeNull();
  });

  it('refuses a heart numeral whose digits are not where the heart numerals end', async () => {
    // The heart numeral is right-aligned: its last glyph ends 4–6 px from the card's border on every
    // card that has one. Erasing the trailing 0 of 艾莉賽's 100 would leave "10" — a number, but not
    // the one on screen — so a numeral that stops 13 px short is refused.
    const image = copyOf(await jpegImage('panel-00.jpg'));
    paint(image, { x: 855, y: 731, w: 11, h: 15 }, [40, 40, 40]);
    expect(await parseOpener(frameOf(image, 1_000))).toBeNull();
  });

  it('refuses a number whose digits are not where the numerals start', async () => {
    // DragonSlayer's 陷阱解除 105 with its leading 1 painted out is "05" — still a number, but not
    // the one the game shows. The numerals are left-aligned, so a first glyph starting 11 px into
    // the band is a missing digit, not a short number.
    const image = copyOf(await jpegImage('panel-00.jpg'));
    paint(image, { x: 781, y: 941, w: 7, h: 14 }, [40, 40, 40]);
    expect(await parseOpener(frameOf(image, 1_000))).toBeNull();
  });

  it('refuses frames that are not the panel', async () => {
    // The same chest with the panel dismissed: no title, no cards.
    expect(await parseOpener(await jpegFrame('after-pick.jpg'))).toBeNull();
    // The QTE bar, and the walking view.
    expect(await parseOpener(await jpegFrame('frame-3.jpg', 1_000, QTE_FIXTURES))).toBeNull();
    expect(await parseOpener(await jpegFrame('minimap-and-hud.jpg', 1_000, NAV_FIXTURES))).toBeNull();
  });

  it('refuses a foreign frame size without paying for its decode', async () => {
    let decodes = 0;
    const frame: Frame = {
      atMs: 0,
      width: 1280,
      height: 720,
      toRgba: async () => {
        decodes += 1;
        return { data: new Uint8Array(1280 * 720 * 4), width: 1280, height: 720 };
      },
    };
    expect(await parseOpener(frame)).toBeNull();
    expect(decodes).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// openerCardCentre — where the loop clicks
// ---------------------------------------------------------------------------------------------

describe('openerCardCentre', () => {
  it('answers the centre of the card a member index sits on', async () => {
    // The measured click that chose DragonSlayer was (781, 899) — its card's centre is a few pixels
    // away, and both points are inside the card measured at x 704–868, y 853–963.
    const centre = openerCardCentre(3);
    expect(centre).not.toBeNull();
    expect(Math.abs(centre!.x - 781)).toBeLessThanOrEqual(20);
    expect(Math.abs(centre!.y - 899)).toBeLessThanOrEqual(20);

    // Six distinct cards, row-major left to right.
    const centres = Array.from({ length: 6 }, (_, index) => openerCardCentre(index)!);
    expect(new Set(centres.map((point) => `${point.x},${point.y}`)).size).toBe(6);
    expect(centres[0]!.y).toBe(centres[2]!.y);
    expect(centres[3]!.y).toBeGreaterThan(centres[0]!.y);
    expect(centres[0]!.x).toBeLessThan(centres[1]!.x);
  });

  it('refuses an index no card sits at', () => {
    expect(openerCardCentre(-1)).toBeNull();
    expect(openerCardCentre(6)).toBeNull();
    expect(openerCardCentre(1.5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// chooseOpener — the policy
// ---------------------------------------------------------------------------------------------

function member(overrides: Partial<OpenerMember> = {}): OpenerMember {
  return { name: '#1', detect: 10, disarm: 10, willpower: 100, feared: false, ...overrides };
}

function panelOf(...members: OpenerMember[]): OpenerPanel {
  return { members };
}

describe('chooseOpener', () => {
  it('chooses the highest 陷阱解除 on the fixture panel: DragonSlayer at card 4', async () => {
    const panel = (await parseOpener(await jpegFrame('panel-00.jpg')))!;
    const choice = chooseOpener(panel);

    expect(choice).not.toBeNull();
    // The measured click chose DragonSlayer (陷阱解除 105) and it is the fourth card, index 3.
    expect(choice!.index).toBe(3);
    expect(choice!.member.disarm).toBe(105);
    expect(choice!.member).toBe(panel.members[3]);
  });

  it('breaks a 陷阱解除 tie with the higher 陷阱发现', () => {
    const choice = chooseOpener(panelOf(
      member({ disarm: 40, detect: 10 }),
      member({ disarm: 40, detect: 30 }),
      member({ disarm: 39, detect: 99 }),
    ));
    expect(choice!.index).toBe(1);
  });

  it('breaks a full tie with the lower index', () => {
    const choice = chooseOpener(panelOf(
      member({ name: '#1', disarm: 40, detect: 20 }),
      member({ name: '#2', disarm: 40, detect: 20 }),
    ));
    expect(choice!.index).toBe(0);
  });

  it('chooses a single qualifying member', () => {
    const choice = chooseOpener(panelOf(member({ disarm: 5 })));
    expect(choice!.index).toBe(0);
    expect(choice!.member.disarm).toBe(5);
  });

  it('refuses when every member is below the willpower floor', () => {
    expect(chooseOpener(panelOf(
      member({ willpower: 59, disarm: 90 }),
      member({ willpower: 10, disarm: 80 }),
    ))).toBeNull();
    expect(chooseOpener(panelOf())).toBeNull();
  });

  it('admits a member exactly at the floor — the floor bars "below", not "at"', () => {
    const choice = chooseOpener(panelOf(member({ willpower: WILLPOWER_FLOOR, disarm: 1 })));
    expect(choice!.index).toBe(0);
  });

  it('never chooses a feared member, however good the numbers', () => {
    const choice = chooseOpener(panelOf(
      member({ willpower: 100, disarm: 200, detect: 200, feared: true }),
      member({ willpower: 100, disarm: 20, detect: 5 }),
    ));
    expect(choice!.index).toBe(1);
  });

  it('honours a caller-supplied floor above the default', () => {
    const panel = panelOf(
      member({ willpower: 70, disarm: 90 }),
      member({ willpower: 95, disarm: 80 }),
    );
    expect(chooseOpener(panel)!.index).toBe(0);
    expect(chooseOpener(panel, 90)!.index).toBe(1);
  });

  it('mirrors the config default the World passes in', () => {
    // `worlds.wvd.willpowerFloor` (contracts §8) is the tunable; the policy's default is the same
    // fact, and this cross-check is what keeps the two from drifting (session.ts's precedent).
    expect(WILLPOWER_FLOOR).toBe(WVD_DEFAULTS.willpowerFloor);
  });
});

// ---------------------------------------------------------------------------------------------
// ChestPerceiver — the opener is tried before the bar
// ---------------------------------------------------------------------------------------------

describe('ChestPerceiver', () => {
  it('reports chest-open with the parsed panel and the frame time', async () => {
    const observation = await new ChestPerceiver().observe(await jpegFrame('panel-00.jpg', 4_321));

    expect(observation.screen).toBe('chest-open');
    expect(observation.atMs).toBe(4_321);
    expect(observation.confidence).toBe(1);
    if (observation.screen !== 'chest-open') throw new Error('not an opener observation');
    expect(observation.opener.members).toHaveLength(6);
    expect(observation.opener.members[3]!.disarm).toBe(105);
  });

  it('still reports chest-qte when the bar is up and no panel is', async () => {
    const observation = await new ChestPerceiver().observe(await jpegFrame('frame-3.jpg', 2_000, QTE_FIXTURES));

    expect(observation.screen).toBe('chest-qte');
    expect(observation.atMs).toBe(2_000);
  });

  it('answers unknown for the opened chest and the walking view', async () => {
    expect((await new ChestPerceiver().observe(await jpegFrame('after-pick.jpg'))).screen).toBe('unknown');
    expect(
      (await new ChestPerceiver().observe(await jpegFrame('minimap-and-hud.jpg', 1_000, NAV_FIXTURES))).screen,
    ).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// The tick budget — contracts §0 rule 7 (observe() inside half a tick, 50 ms)
// ---------------------------------------------------------------------------------------------

describe('the half-tick budget', () => {
  it('keeps observe inside 50 ms on the opener panel', async () => {
    const images = await Promise.all([jpegImage('panel-00.jpg'), jpegImage('panel-01.jpg')]);
    const perceiver = new ChestPerceiver();
    const samples: number[] = [];

    for (let round = 0; round < 10; round += 1) {
      for (const image of images) {
        const start = performance.now();
        const observation = await perceiver.observe(frameOf(image, round * 100));
        samples.push(performance.now() - start);
        expect(observation.screen).toBe('chest-open');
      }
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    expect(p50).toBeLessThan(50);
  });
});
