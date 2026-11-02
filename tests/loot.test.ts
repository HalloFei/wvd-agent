import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Frame, Point, RgbaImage } from '../src/contracts.ts';
import { dismissLoot, LOOT_COLLECT_AT, LOOT_DISMISS_AT, tapLoot } from '../src/actions/chest.ts';
import { LootPerceiver } from '../src/perception/loot.ts';

/**
 * The loot overlay is the screen the chest chain could not name: the party HUD is not drawn on it,
 * the bar is gone (or was never there) and the opener panel has left, so the composite fell through
 * to `unknown` and the route's answer to an unnamed screen is wait. It is one screen, and it needs one
 * tap.
 *
 * The fixture is the committed 2026-10-31 capture, `loot-00.jpg` at 1280x720 — the corpus's only loot
 * frame. The World's client is 1920x1080 (contracts §0.5), so the perceiver is written in frame
 * fractions and the second test pins that by rendering the same capture at the World's size. That
 * upscale is **synthetic**, not a native 1920 capture (one is still owed): it proves the geometry is
 * fractions, not pixels.
 *
 * The negatives are the frames around it in the real chain: the 3-D view after a QTE cancel, the
 * opening lid, the opener panel, the 打开 prompt, the QTE bar — plus the two non-chest screens that
 * also draw bright horizontal lines, the dungeon map and a dialog. `open-07.jpg` is the closest
 * structural impostor: its lid edge draws border rows with gains 62/76 against the loot card's 76/65,
 * so the border test alone cannot separate them; the flat card interior and the 获得了 caption do.
 *
 * `tapLoot` is the measured live manual collect at (960, 510) on the 1920x1080 client.
 */
const LOOT = new URL('../testdata/chest/2026-10-31-loot/', import.meta.url);
const CHEST = new URL('../testdata/chest/2026-10-24-live-qte/', import.meta.url);
const OPENER = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const VIEW = new URL('../testdata/nav-2026-10-31-cancel/', import.meta.url);
const DIALOG = new URL('../testdata/nav-1024-0213/', import.meta.url);
const NARROW = new URL('../testdata/chest/2026-10-31-narrow-qte/', import.meta.url);

/** A shipped still costs ~0.2 s to decode; several tests read the same one, so decode once. */
const cache = new Map<string, Promise<RgbaImage>>();

function image(name: string, dir: URL): Promise<RgbaImage> {
  const key = new URL(name, dir).href;
  let decoded = cache.get(key);
  if (decoded === undefined) {
    decoded = readFile(new URL(name, dir)).then((bytes) => {
      const still = jpeg.decode(bytes, { useTArray: true });
      return { data: still.data, width: still.width, height: still.height };
    });
    cache.set(key, decoded);
  }
  return decoded;
}

const frameOf = (image: RgbaImage): Frame => ({
  atMs: 0,
  width: image.width,
  height: image.height,
  toRgba: async () => image,
});

/** Nearest-neighbour scaling: the test's own synthetic rendering of the 1280 capture at another size. */
function scaled(image: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const from = (sourceY * image.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      data[to] = image.data[from]!;
      data[to + 1] = image.data[from + 1]!;
      data[to + 2] = image.data[from + 2]!;
      data[to + 3] = image.data[from + 3]!;
    }
  }
  return { data, width, height };
}

describe('LootPerceiver', () => {
  const perceiver = new LootPerceiver();

  it('names the committed loot overlay', async () => {
    const observation = await perceiver.observe(frameOf(await image('loot-00.jpg', LOOT)));
    expect(observation.screen).toBe('loot');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("names the same overlay at the World's 1920x1080 size", async () => {
    // Synthetic: the committed capture is 1280x720 and no native 1920 loot frame exists. The
    // perceiver measures fractions, so the same card must land at the World's size.
    const observation = await perceiver.observe(frameOf(scaled(await image('loot-00.jpg', LOOT), 1920, 1080)));
    expect(observation.screen).toBe('loot');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('never takes the screens around the chest', async () => {
    const cases: Array<[string, URL]> = [
      // The 3-D view after a QTE cancel: warm stone, HUD up, no card.
      ['after-cancel.jpg', VIEW],
      // The opening frames; open-07's lid edge is the closest structural impostor to the card's lines.
      ['open-00.jpg', CHEST],
      ['open-07.jpg', CHEST],
      ['panel-00.jpg', OPENER],
      ['prompt-ffxi.jpg', OPENER],
      ['qte-00.jpg', CHEST],
      // A dungeon map and a dialog: both draw bright horizontal lines, neither has the flat card.
      ['map.jpg', DIALOG],
      ['popup.jpg', DIALOG],
    ];
    for (const [name, dir] of cases) {
      const observation = await perceiver.observe(frameOf(await image(name, dir)));
      expect(observation.screen, name).not.toBe('loot');
    }
  });

  it('refuses a frame that cannot be the client', async () => {
    // A QTE bar crop (631x699): the overlay's fractions do not survive a crop, so the frame is not
    // measured at all.
    const narrow = await perceiver.observe(frameOf(await image('bar.jpg', NARROW)));
    expect(narrow.screen).not.toBe('loot');

    // A flat field is "nothing was drawn": the only refusal that may end a session (contracts §2).
    const black: RgbaImage = { data: new Uint8Array(640 * 360 * 4), width: 640, height: 360 };
    const flat = await perceiver.observe(frameOf(black));
    expect(flat.screen).toBe('unknown');
    expect(flat.confidence).toBe(0);
  });
});

/** One tap, recorded; any other gesture means the action changed shape and fails loudly. */
function recordingActuator(result: ActionResult = { ok: true }): Actuator & { readonly taps: Point[] } {
  const taps: Point[] = [];
  return {
    taps,
    tap: async (at) => {
      taps.push(at);
      return result;
    },
    doubleTap: () => {
      throw new Error('tapLoot must tap once, not double-tap');
    },
    holdKey: () => {
      throw new Error('tapLoot must not press a key');
    },
    drag: () => {
      throw new Error('tapLoot must not drag');
    },
  };
}

describe('tapLoot', () => {
  it('collects with exactly one tap at the measured point', async () => {
    const actuator = recordingActuator();
    const result = await tapLoot(actuator);
    expect(result).toEqual({ ok: true });
    expect(actuator.taps).toEqual([{ x: 960, y: 510 }]);
    // The number is the measurement, not a default: a re-measured point re-pins this test.
    expect(LOOT_COLLECT_AT).toEqual({ x: 960, y: 510 });
  });

  it('returns a foreground refusal unchanged, without retrying', async () => {
    const rejected: ActionResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };
    const actuator = recordingActuator(rejected);
    await expect(tapLoot(actuator)).resolves.toBe(rejected);
    expect(actuator.taps).toHaveLength(1);
  });
});

/**
 * The result banner: the card is collected and the game draws `获得了…` over the opened chest.
 * Live 2026-11-01 the composite named that frame `chest-opening` 0.60 (the opening's warm-mass and
 * no-HUD gates both pass on it), the route's answer to an opening is wait, and the farm stood on the
 * one screen that needs a single tap — the continue arrow at (1203, 1040).
 */
const BANNER = new URL('../testdata/chest/2026-11-01-loot-banner/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);

/**
 * The operator's rule (2026-11-03): *the loot screen has the loot name and the loot item image, and
 * thus in no case can perception be wrong with it.* A qualified loot frame carries **both** — the
 * caption below the card and the saturated item art inside it. The battle's skill detail panel
 * (关闭 / 队列) passed the name-only gates and was named `loot` live at 03:17; the loop then tapped
 * the loot card's point (960,510) ten times into the battle. This is the regression guard.
 */
describe('a qualified loot frame', () => {
  it('needs the item image as well as the name', async () => {
    for (const name of ['slot-panel-opening.jpg', 'slot-panel-slow-attack.jpg', 'alice-command-phase.jpg']) {
      const observation = await new LootPerceiver().observe(frameOf(await image(name, BATTLE)));
      expect(observation.screen).toBe('unknown');
    }
    // The real loot card still qualifies: the same caption, and 2 342 saturated pixels of item art.
    const loot = await new LootPerceiver().observe(frameOf(await image('loot-00.jpg', LOOT)));
    expect(loot.screen).toBe('loot');
  });
});

describe('the loot result banner', () => {
  it('is named loot, so the route has a rule for it', async () => {
    const observation = await new LootPerceiver().observe(frameOf(await image('result.jpg', BANNER)));
    expect(observation.screen).toBe('loot');
  });

  it('is dismissed with one tap at the measured continue arrow', async () => {
    const actuator = recordingActuator();
    await expect(dismissLoot(actuator)).resolves.toEqual({ ok: true });
    expect(actuator.taps).toEqual([{ x: 1_203, y: 1_040 }]);
    expect(LOOT_DISMISS_AT).toEqual({ x: 1_203, y: 1_040 });
  });
});
