/**
 * The chest opener panel `由谁打开?` (Task 12), read from `testdata/chest/2026-10-24-opener/`.
 *
 * The fixture is **one live panel**: `panel-00.jpg` and `panel-01.jpg` are two captures of the same
 * screen, and `measurements.json` is the reading of it — every expected field (陷阱发现, 陷阱解除 and
 * the 心/willpower numeral) is loaded from that JSON, not re-typed here, so the test cannot disagree
 * with the measurement it is testing. DragonSlayer's card draws **no heart**, and the JSON records
 * that as `null`: the parser may never substitute a number for it.
 *
 * Negative controls are the frames that have been mistaken for things before: the QTE bar, the 3-D
 * view, and `after-pick.jpg` — the same chest once the panel was dismissed.
 */
import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { WVD_DEFAULTS } from '../src/config.ts';
import type { Actuator, Frame, OpenerMember, OpenerPanel, Point, RgbaImage } from '../src/contracts.ts';
import { tapOpenerCard } from '../src/actions/opener.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import {
  OPENER_SLOTS,
  openerCardCentre,
  openerSlot,
  parseOpener,
  parseOpenerDetailed,
} from '../src/perception/opener.ts';
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

/**
 * Copy a 陷阱 glyph's *shape* into a heart-numeral position, recoloured as the heart's yellow
 * (231, 231, 103) on the card fill. The heart's segmentation is chroma-based, so this is how a digit
 * the heart font has never been observed to draw can be put on the card.
 */
function blitYellowGlyph(image: RgbaImage, source: Rect, target: { x: number; y: number }): void {
  for (let y = 0; y < source.h; y += 1) {
    for (let x = 0; x < source.w; x += 1) {
      const from = ((source.y + y) * image.width + (source.x + x)) * 4;
      const to = ((target.y + y) * image.width + (target.x + x)) * 4;
      const luma = (77 * image.data[from]! + 150 * image.data[from + 1]! + 29 * image.data[from + 2]!) >> 8;
      const ink = luma >= 120;
      image.data[to] = ink ? 231 : 54;
      image.data[to + 1] = ink ? 231 : 54;
      image.data[to + 2] = ink ? 103 : 54;
      image.data[to + 3] = 255;
    }
  }
}

/** What `measurements.json` says the six cards carry. `willpower: null` = the card draws no heart. */
interface MeasuredMember {
  readonly name: string;
  readonly detect: number;
  readonly disarm: number;
  readonly willpower: number | null;
}

/** The JSON's willpower column as the parser records it: `null` = no heart drawn, a number = read. */
function expectedWillpower(members: readonly MeasuredMember[]): Array<number | null> {
  return members.map((member) => member.willpower);
}

let measuredMembers: Promise<readonly MeasuredMember[]> | null = null;
function measured(): Promise<readonly MeasuredMember[]> {
  measuredMembers ??= readFile(MEASUREMENTS, 'utf8').then(
    (text) => (JSON.parse(text) as { members: MeasuredMember[] }).members,
  );
  return measuredMembers;
}


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

  it('reads the heart numeral as willpower, and records a card with no heart as absent', async () => {
    const expected = await measured();
    const panel = await parseOpener(await jpegFrame('panel-00.jpg'));

    expect(panel!.members.map((member) => member.willpower)).toEqual(expectedWillpower(expected));
    // DragonSlayer (card 4) draws no heart at all: that is the main character, whose willpower the
    // game never displays, so the value is `null` — eligible, and distinguishable from a heart that
    // is drawn but unreadable (`NaN`). Nothing is inferred from the other cards' hearts.
    expect(panel!.members[3]!.willpower).toBeNull();
    expect(panel!.members[0]!.willpower).toBe(100);
    expect(panel!.members[4]!.willpower).toBe(90);
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
    expect(panel!.members.map((member) => member.willpower)).toEqual(expectedWillpower(expected));
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

  it('records a heart numeral that stops short as unread, never as the shorter number', async () => {
    // The heart numeral is right-aligned: its last glyph ends 4–6 px from the card's border on every
    // card that has one. Erasing the trailing 0 of 艾莉賽's 100 would leave "10" — a number, but not
    // the one on screen — so the numeral is unread and that card is ineligible. The panel itself is
    // not refused: the cards sit at fixed positions, so the other five are still measurable and the
    // click only needs the slot of the card the policy chose.
    const image = copyOf(await jpegImage('panel-00.jpg'));
    paint(image, { x: 855, y: 731, w: 11, h: 15 }, [40, 40, 40]);
    const panel = await parseOpener(frameOf(image, 1_000));

    expect(panel).not.toBeNull();
    expect(Number.isNaN(panel!.members[0]!.willpower)).toBe(true);
    expect(panel!.members[1]!.willpower).toBe(100);
    // No substitution: the unread card cannot win. The choice is still DragonSlayer (index 3), whose
    // card draws no heart at all — the main character is eligible without a displayed willpower.
    expect(chooseOpener(panel!)!.index).toBe(3);
  });

  it('records a heart digit the atlas has never seen as unread, and names the other five', async () => {
    // The heart font's other digits were never captured (only 0, 1 and 9 on this panel). Take the
    // 陷阱 font's 4 — the nearest unseen shape the fixture has — erase 艾莉賽's 100 and put it where
    // the heart numeral goes, recoloured yellow so the heart's own segmentation sees it. The atlas
    // holds instances, not a mean, so a shape it has never seen is refused; a nearest-of-{0,1,9}
    // matcher would have read this as a 1 and accepted a willpower that was never on the screen.
    // Not reading it costs 艾莉賽's card only: her willpower is unread and the other five stand.
    const image = copyOf(await jpegImage('panel-00.jpg'));
    paint(image, { x: 838, y: 731, w: 28, h: 15 }, [54, 54, 54]);
    blitYellowGlyph(image, { x: 957, y: 941, w: 7, h: 13 }, { x: 858, y: 732 });

    const parsed = await parseOpenerDetailed(frameOf(image, 1_000));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Number.isNaN(parsed.panel.members[0]!.willpower)).toBe(true);
    // #4 draws no heart at all, so it is unread too; #5 and #6 keep their measured numerals.
    expect(parsed.panel.members.slice(1).map((member) => member.willpower)).toEqual([100, 100, null, 90, 100]);
  });

  it('reads a panel with every heart erased as six absent cards, and still has a card to click', async () => {
    // Not a state the game draws (a party has one main character, and only their card omits the
    // heart): erasing a heart removes the numeral *and* the glyph, so every slot reads as absent
    // (`null`), not unread (`NaN`). An absent heart is the one case the floor cannot rule on, so the
    // policy still clicks the best 陷阱解除 rather than asking about a panel it can rank. The
    // degradation that matters is pinned above: one card's drawn heart failing to read costs that
    // card only.
    const image = copyOf(await jpegImage('panel-00.jpg'));
    for (const slot of OPENER_SLOTS) {
      if (slot.index === 3) continue; // DragonSlayer draws no heart, so there is nothing to erase.
      paint(image, { x: slot.rect.x1 - 70, y: slot.rect.y0 + 1, w: 67, h: 16 }, [54, 54, 54]);
    }
    const panel = await parseOpener(frameOf(image, 1_000));

    expect(panel).not.toBeNull();
    expect(panel!.members.map((member) => member.willpower)).toEqual([null, null, null, null, null, null]);
    const choice = chooseOpener(panel!);
    expect(choice?.index).toBe(3);
    expect(choice!.member.disarm).toBe(105);
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
    // The reasons differ: a frame that is not the panel falls through to the bar; a recognised
    // panel that cannot be read whole escalates as `unknown` at a small positive confidence.
    expect(await parseOpenerDetailed(await jpegFrame('after-pick.jpg')))
      .toEqual({ ok: false, reason: 'not-panel' });
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
  it('answers the measured centre of every card, exactly', async () => {
    // The card boxes are x 704–868 / 879–1046 / 1057–1220 and y 729–839 / 853–963 (measurements.json).
    // DragonSlayer's card is index 3, the fourth card: centre (786, 908), which is 3–9 px from the
    // operator's recorded click (781, 899) and the point the loop clicks now.
    expect(openerCardCentre(3)).toEqual({ x: 786, y: 908 });
    expect(Array.from({ length: 6 }, (_, index) => openerCardCentre(index))).toEqual([
      { x: 786, y: 784 },
      { x: 963, y: 784 },
      { x: 1139, y: 784 },
      { x: 786, y: 908 },
      { x: 963, y: 908 },
      { x: 1139, y: 908 },
    ]);
  });

  it('refuses an index no card sits at', () => {
    expect(openerCardCentre(-1)).toBeNull();
    expect(openerCardCentre(6)).toBeNull();
    expect(openerCardCentre(1.5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The fixed card slots — how a click finds a card without reading the panel
// ---------------------------------------------------------------------------------------------

describe('the fixed card slots', () => {
  it('names the six positions the legacy script clicked, in card order', () => {
    expect(OPENER_SLOTS.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(OPENER_SLOTS.map((slot) => slot.id)).toEqual([
      'top-left', 'top-middle', 'top-right',
      'bottom-left', 'bottom-middle', 'bottom-right',
    ]);
  });

  it('carries the measured box and centre of a slot, so a click needs no detection', () => {
    // The panel does not move: the same grid in panel-00/01/02 and in the live FFXI capture.
    expect(openerSlot(4)).toEqual({
      index: 4,
      id: 'bottom-middle',
      rect: { x0: 879, y0: 853, x1: 1046, y1: 963 },
      centre: { x: 963, y: 908 },
    });
    expect(openerSlot(0)!.centre).toEqual({ x: 786, y: 784 });
    expect(openerSlot(5)!.centre).toEqual({ x: 1139, y: 908 });
    expect(openerSlot(-1)).toBeNull();
    expect(openerSlot(6)).toBeNull();
    expect(openerSlot(1.5)).toBeNull();
  });
});

describe('tapOpenerCard', () => {
  function actuatorWith(taps: Point[]): Actuator {
    return {
      tap: async (at) => {
        taps.push(at);
        return { ok: true };
      },
      doubleTap: async () => ({ ok: true }),
      holdKey: async () => ({ ok: true }),
      drag: async () => ({ ok: true }),
    };
  }

  it('taps the fixed centre of the chosen slot', async () => {
    const taps: Point[] = [];
    expect(await tapOpenerCard(actuatorWith(taps), 4)).toEqual({ ok: true });
    expect(taps).toEqual([{ x: 963, y: 908 }]);
  });

  it('refuses a slot no card sits at, without tapping', async () => {
    const taps: Point[] = [];
    expect((await tapOpenerCard(actuatorWith(taps), 6)).ok).toBe(false);
    expect(taps).toEqual([]);
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
  it('chooses the main character on the fixture panel, whose card draws no heart at all', async () => {
    const panel = (await parseOpener(await jpegFrame('panel-00.jpg')))!;
    const choice = chooseOpener(panel);

    expect(choice).not.toBeNull();
    // The fixture's highest 陷阱解除 is DragonSlayer's 105, and his card draws no heart: that is the
    // main character, whose willpower the game does not display (contracts §OpenerMember). The floor
    // cannot be checked against a number that is not on the screen, so he is eligible and wins.
    expect(choice!.index).toBe(3);
    expect(choice!.member.disarm).toBe(105);
    expect(choice!.member).toBe(panel.members[3]);
    expect(panel.members[3]!.willpower).toBeNull();
  });

  it('skips a member whose heart did not parse even when it would win on 陷阱解除', () => {
    // The decision, not the arithmetic: with the unread card treated as eligible, index 0 would win.
    const choice = chooseOpener(panelOf(
      member({ disarm: 200, detect: 200, willpower: Number.NaN }),
      member({ disarm: 40, detect: 10, willpower: 100 }),
    ));
    expect(choice).not.toBeNull();
    expect(choice!.index).toBe(1);
    expect(choice!.member.disarm).toBe(40);

    // Nobody else qualifies either: no substitution, no choice.
    expect(chooseOpener(panelOf(member({ willpower: Number.NaN, disarm: 200 })))).toBeNull();
    expect(chooseOpener(panelOf(
      member({ willpower: Number.NaN, disarm: 200 }),
      member({ willpower: 59, disarm: 100 }),
    ))).toBeNull();
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

  it('reports a recognised but unreadable panel as unknown at a small positive confidence', async () => {
    const image = copyOf(await jpegImage('panel-00.jpg'));
    paint(image, { x: 788, y: 794, w: 10, h: 15 }, [235, 235, 235]);

    const observation = await new ChestPerceiver().observe(frameOf(image, 1_234));

    // 0.3 is below the route's 0.5 act floor (nothing is clicked) and above 0 (a session must not
    // stop on a frame that clearly carries the modal): the classifier escalates for a human.
    expect(observation.screen).toBe('unknown');
    expect(observation.confidence).toBe(0.3);
    expect(observation.atMs).toBe(1_234);
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

/**
 * R30: the live path decodes with GDI+, the fixtures with jpeg-js, and the two disagree by one pixel
 * on a numeral's right edge. This is the case that difference broke: the same panel must parse
 * through the decoder the World actually uses.
 */
describe('parseOpener — through the native decoder', () => {
  const WINDOWS = process.platform === 'win32';

  async function gdiFrame(name: string): Promise<Frame | null> {
    const { decodeJpeg, gdiplusProblem } = await import('../src/engine/gdiplus.mjs');
    if (gdiplusProblem() !== '') return null;
    const bytes = await readFile(new URL(name, FIXTURES));
    const image = await decodeJpeg(bytes);
    return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
  }

  it.skipIf(!WINDOWS)('parses panel-00 after a GDI+ decode', async () => {
    const frame = await gdiFrame('panel-00.jpg');
    if (frame === null) return;
    const panel = await parseOpener(frame);
    expect(panel).not.toBeNull();
    expect(panel!.members).toHaveLength(6);
    expect(panel!.members[0]!.willpower).toBe(100);
  });

  it.skipIf(!WINDOWS)('parses the live FFXI panel, leaving the one card the atlas cannot read unread', async () => {
    // The panel the live chest showed: GDI+ renders 爱丽丝's 90 below the heart atlas's identity
    // floor, so that card is unread. The fixed grid means the card still has a click point, and the
    // panel is not refused — the live chest becomes openable with the best card that was read.
    const frame = await gdiFrame('panel-ffxi.jpg');
    if (frame === null) return;
    const parsed = await parseOpenerDetailed(frame);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.panel.members.map((member) => member.detect)).toEqual([38, 28, 34, 93, 62, 78]);
    expect(parsed.panel.members.map((member) => member.disarm)).toEqual([49, 50, 38, 106, 43, 81]);
    expect(parsed.panel.members.map((member) => member.willpower)
      .map((value) => (value === null ? 'absent' : Number.isNaN(value) ? 'unread' : value)))
      .toEqual([100, 100, 100, 'absent', 'unread', 100]);

    // DragonSlayer (no heart: the main character) holds the best 陷阱解除 (106) and is eligible;
    // 爱丽丝 (heart drawn, unreadable) stays ineligible, so the choice is the bottom-left card.
    const choice = chooseOpener(parsed.panel);
    expect(choice?.index).toBe(3);
    expect(openerSlot(choice!.index)!.id).toBe('bottom-left');
    expect(openerCardCentre(choice!.index)).toEqual({ x: 786, y: 908 });
  });
});
