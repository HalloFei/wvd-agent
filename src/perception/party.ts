/**
 * The battle party panel: six member cards under the command row, and which card is the one whose
 * command phase is up.
 *
 * Measured 2026-11-02 on the 1920×1080 client (`testdata/battle-2026-11-02/`, `screens/2026-10-25-live/`).
 * The panel is a 3×2 grid of cards. The card of the member whose turn it is is tinted gold across its
 * whole face; the other five stay the neutral dark of the panel, and a card the enemy has marked is
 * tinted red. The gold face is the turn marker this reader keys on.
 *
 * The cards carry the names the operator gave (2026-11-02), in this fixed order — that roster is
 * `PARTY_MEMBERS`, and the reader answers the active card's roster name. A party change is a roster
 * change; the reader can only answer names it was given.
 *
 * The gold measure is `min(r, g) - b` averaged over the card's face, sampled 8 px inside the card
 * so neither its border nor its glow is counted. Measured on the two frames with the command phase
 * up: 53.7 and 33.9 on the turn card, against 3.5 at most on the other five of the same frame. A red
 * tinted card (the enemy's mark) scores 2.3, so red never reads as gold.
 *
 * Two guards, in this order:
 *
 * - The battle HUD's own evidence (`battleHudUp`): the panel is drawn by the battle, so a frame
 *   without it cannot be answered, however gold the scenery is. Over the 79 recorded 1920×1080
 *   frames the highest gold on a non-battle frame is the 3-D map `nav-2026-10-24-ffxi4f/third-floor-glow.jpg`
 *   at 18.6, and the world map's faces are uniformly gold (49.8 against 42.8) — both are refused.
 * - The floor and the lead: the turn card's face must clear `ACTIVE_GOLD_MIN` and lead the runner-up
 *   by `ACTIVE_GOLD_RATIO`. When the skill panel is open the cards are dimmed behind it (5.5 at
 *   most), so the reader answers nothing there — the World reads at the command phase, before any
 *   slot is tapped.
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

/** The face is sampled this far inside the card: the border and the glow are not the tint. */
const CARD_INSET = 8;

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

/** The turn card's face clears this. Measured: 53.7 and 33.9 on the turn card, 3.5 at most otherwise. */
export const ACTIVE_GOLD_MIN = 20;

/** …and it leads the runner-up by this factor. Measured leading factor: 15.3 and 10.3. */
export const ACTIVE_GOLD_RATIO = 2.5;

/**
 * The gold of each card's face, in card order. `null` unless the frame is the reference size: the
 * rects are geometry of the 1920×1080 client and mean nothing on another size.
 */
export function partyGoldScores(image: RgbaImage): readonly number[] | null {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return null;
  return PARTY_CARDS.map((card) => goldOf(image, card));
}

/** The active member's name, or null when this frame does not say which card is up. */
export function activePartyMember(image: RgbaImage): string | null {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return null;
  if (!battleHudUp(readFacts(image))) return null;
  const scores = partyGoldScores(image);
  if (scores === null) return null;

  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index]! > scores[best]!) best = index;
  }
  const gold = scores[best]!;
  const runnerUp = Math.max(...scores.filter((_, index) => index !== best));
  if (gold < ACTIVE_GOLD_MIN || gold < ACTIVE_GOLD_RATIO * runnerUp) return null;
  return PARTY_MEMBERS[best] ?? null;
}

/** `min(r, g) - b` over the card's face: a gold face scores high, a red or neutral one does not. */
function goldOf(image: RgbaImage, card: PixelRect): number {
  const x0 = card.x + CARD_INSET;
  const y0 = card.y + CARD_INSET;
  const x1 = card.x + card.width - CARD_INSET;
  const y1 = card.y + card.height - CARD_INSET;
  const { data, width } = image;
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const offset = (row + x) * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      sum += Math.min(r, g) - b;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
