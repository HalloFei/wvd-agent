/**
 * The battle party panel: six member cards under the command row, and which card is the one whose
 * command phase is up.
 *
 * Measured 2026-11-02 and 2026-11-03 on the 1920×1080 client (`testdata/battle-2026-11-02/`,
 * `screens/2026-10-25-live/`). The panel is a 3×2 grid of cards. The card of the member whose turn it
 * is is drawn with a **yellow-to-orange frame** — the operator's own reading, 2026-11-03: *the active
 * icon is yellow to orange, while inactive is white* — and its face is tinted gold too. The other five
 * frames stay white/grey, and a card the enemy has marked is tinted red.
 *
 * The frame is what the reader keys on: `max(r, g) - b` averaged over a 3 px ring just inside the
 * card's edge. Measured on the three command-phase frames (1920×1080):
 *
 * | frame | turn card | the other five |
 * | --- | --- | --- |
 * | `alice-command-phase.jpg` (爱丽丝) | **68.8** | 6.0–16.4 |
 * | `command-phase.jpg` (DragonSlayer) | **98.9** | 4.3–32.9 |
 * | `screens/2026-10-25-live/combat-command.jpg` (DragonSlayer) | **63.2** | 3.4–17.4 |
 *
 * The red-marked card is the highest non-turn score (32.9) and still under the floor; a white frame
 * scores near zero. The face tint (`min(r, g) - b` over the face, 8 px inside) separates more cleanly
 * still — 33.9–53.7 against ≤ 3.5 — but the frame is the marker the game itself draws, so the reader
 * follows it.
 *
 * The cards carry the names the operator gave (2026-11-02), in this fixed order — that roster is
 * `PARTY_MEMBERS`, and the reader answers the active card's roster name. A party change is a roster
 * change; the reader can only answer names it was given.
 *
 * Two guards, in this order:
 *
 * - The battle HUD's own evidence (`battleHudUp`): the panel is drawn by the battle, so a frame
 *   without it cannot be answered, however bright the scenery is.
 * - The floor and the lead: the turn card's frame must clear `ACTIVE_FRAME_MIN` and lead the runner-up
 *   by `ACTIVE_FRAME_RATIO`. When the skill panel is open the cards are dimmed behind it, so the
 *   reader answers nothing there — the World reads at the command phase, before any slot is tapped.
 *
 * A frame the reader cannot answer is `null`, the contract's miss (contracts §11), never an error:
 * the loop takes its default action and no slot is tapped for a member it could not name.
 */
import type { PixelRect, RgbaImage } from '../contracts.ts';
import { battleHudUp } from './combat.ts';
import { readFacts } from './facts.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** The six card faces, measured 2026-11-02: 190 px wide, 114 px tall, on a 194 px pitch. */
export const PARTY_CARDS: readonly PixelRect[] = [
  { x: 668, y: 829, width: 192, height: 114 },
  { x: 862, y: 829, width: 192, height: 114 },
  { x: 1_056, y: 829, width: 192, height: 114 },
  { x: 668, y: 957, width: 192, height: 114 },
  { x: 862, y: 957, width: 192, height: 114 },
  { x: 1_056, y: 957, width: 192, height: 114 },
];

/** The frame's ring: from this many pixels inside the card's edge, this many pixels wide. */
const FRAME_INSET = 2;
const FRAME_WIDTH = 4;

/**
 * The party roster in card order, as the panel draws the names (operator, 2026-11-02). The names are
 * the game's own spellings; the filter folds the traditional variants the operator may type
 * (`src/actions/battle.ts`).
 */
export const PARTY_MEMBERS: readonly string[] = [
  '艾莉赛',
  '本杰明',
  '拉纳维尔',
  'DragonSlayer',
  '爱丽丝',
  '薇薇安娜DEX6',
];

/** The turn card's frame clears this. Measured: 63.2–98.9 on the turn card, 32.9 at most otherwise. */
export const ACTIVE_FRAME_MIN = 40;

/** …and it leads the runner-up by this factor. Measured leading factor: 1.9–4.2. */
export const ACTIVE_FRAME_RATIO = 1.5;

/**
 * The warmth of each card's frame, in card order: `max(r, g) - b` averaged over a 3 px ring just
 * inside the card's edge. A yellow-to-orange frame scores high; a white, grey or red one does not.
 * `null` unless the frame is the reference size: the rects are geometry of the 1920×1080 client.
 */
export function partyFrameWarmth(image: RgbaImage): readonly number[] | null {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return null;
  return PARTY_CARDS.map((card) => frameWarmthOf(image, card));
}

/** The active member's name, or null when this frame does not say which card is up. */
export function activePartyMember(image: RgbaImage): string | null {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return null;
  if (!battleHudUp(readFacts(image))) return null;
  const scores = partyFrameWarmth(image);
  if (scores === null) return null;

  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index]! > scores[best]!) best = index;
  }
  const warm = scores[best]!;
  const runnerUp = Math.max(...scores.filter((_, index) => index !== best));
  if (warm < ACTIVE_FRAME_MIN || warm < ACTIVE_FRAME_RATIO * runnerUp) return null;
  return PARTY_MEMBERS[best] ?? null;
}

/** `max(r, g) - b` over the card's frame ring: gold scores high, white, grey and red do not. */
function frameWarmthOf(image: RgbaImage, card: PixelRect): number {
  const { data, width } = image;
  const left = card.x + FRAME_INSET;
  const top = card.y + FRAME_INSET;
  const right = card.x + card.width - FRAME_INSET;
  const bottom = card.y + card.height - FRAME_INSET;
  let sum = 0;
  let count = 0;
  const add = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    const warm = Math.max(data[offset]!, data[offset + 1]!) - data[offset + 2]!;
    sum += warm;
    count += 1;
  };
  for (let d = 0; d < FRAME_WIDTH; d += 1) {
    for (let x = left; x < right; x += 1) {
      add(x, top + d);
      add(x, bottom - 1 - d);
    }
    for (let y = top; y < bottom; y += 1) {
      add(left + d, y);
      add(right - 1 - d, y);
    }
  }
  return count === 0 ? 0 : sum / count;
}
