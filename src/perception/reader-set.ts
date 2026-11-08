/**
 * The one ordered set of screen recognisers, and the only place a caller gets one.
 *
 * Three callers used to each hold their own copy of this list — the app (`main.ts`), the live CLI
 * (`scripts/live.ts`) and the triage script (`scripts/classify-frame.ts`) — and they had drifted:
 * 18 readers in the app, 16 in the CLI, 12 in the triage script, with no site descriptor and no trust
 * factor below the app. That drift is not cosmetic: on 2026-11-08 20:28 a saved frame of the character
 * page classified `character-page 0.97` through the triage copy while the app named the same instant
 * `dungeon 0.80`, so a stall was diagnosed against a reader set production does not run.
 *
 * A reader set is data: the order is an optimisation (a frame's facts leave at most a few screens
 * standing, `composite.ts`), the floors are per screen, and the site descriptor carries the numbers
 * that are per location (`site.ts`). The app adds what only the app has — the site, the OCR tiers and
 * the trust book — through arguments, so every caller composes **the same** chain and a saved frame
 * answers the same question the loop asked.
 *
 * Order notes that must not be re-shuffled without re-measuring (each one was a live stall):
 *
 * - the item-claim screen before the opening: the result banner clears the opening's gates too;
 * - the inn rest scene before the opening: a blurred inn looks like the chest's warm mass;
 * - the character page before the HUD: its full-screen menu leaves the scene under it readable;
 * - the death scene before anything that reads the dungeon HUD;
 * - the world map, the town and the Dungeon Select list last: the HUD refuses them at 0.2, so a
 *   dungeon frame never pays for them;
 * - the revive QTE last: it is the battle's modal ring, and a frame already named must win first.
 */
import type { ScreenId } from '../contracts.ts';
import { UiMenuPerceiver } from '../ui/menu.ts';
import { CharacterPagePerceiver } from './character-page.ts';
import { ChestPerceiver, type ChestPerceiverOptions } from './chest.ts';
import { ChestOpeningPerceiver } from './chest-opening.ts';
import { CombatPerceiver } from './combat.ts';
import { CompositePerceiver, type Recogniser } from './composite.ts';
import { MainCharacterDeathPerceiver } from './death.ts';
import { DungeonSelectPerceiver } from './dungeon-select.ts';
import { HarkenMenuPerceiver } from './harken.ts';
import { HudPerceiver } from './hud.ts';
import { InnPerceiver } from './inn.ts';
import { InnRestPerceiver } from './inn-rest.ts';
import { TownPerceiver, WorldMapPerceiver } from './location.ts';
import { LootPerceiver } from './loot.ts';
import { MapPerceiver } from './map.ts';
import { MessagePerceiver } from './message.ts';
import { ChestPromptPerceiver } from './prompt.ts';
import type { OcrReadout } from './readout-ocr.ts';
import { ReviveQtePerceiver } from './revive-qte.ts';
import type { SiteDescriptor } from './site.ts';

/**
 * The confidence at which a recogniser's answer is trusted (contracts §3). One number for every
 * screen type on purpose: the floors are the *recognisers'* own (each returns a graded confidence and
 * refuses below its own internal gates), and this is the loop's act floor — the same 0.5 the live CLI
 * answers with, so what the CLI prints is what the loop acts on.
 */
export const ACTING_CONFIDENCE_FLOOR = 0.5;

export interface ScreenReadersOptions {
  /** The site's evidence policy (site.ts). The app passes FFXI_GCN; a script may pass none. */
  readonly site?: SiteDescriptor;
  /** The map readout's OCR escalation (readout-ocr.ts). Absent means the local digit reader only. */
  readonly readoutOcr?: OcrReadout;
  /** The opener's own options: the trap reader, the panel's allowance, the tier report. */
  readonly opener?: ChestPerceiverOptions;
  /** The act floor; defaults to {@link ACTING_CONFIDENCE_FLOOR}. */
  readonly floor?: number;
  /** Verification by action (policy/trust.ts): the per-screen floor multiplier. */
  readonly floorFactor?: (screen: ScreenId) => number;
}

/** The chain, plus the two instances the loop needs by name (the map aims, the chest reads the panel). */
export interface ScreenReaders {
  readonly composite: CompositePerceiver;
  readonly map: MapPerceiver;
  readonly chest: ChestPerceiver;
  /** The readings behind the chain, in try order. */
  readonly recognisers: readonly Recogniser[];
}

/** Build the ordered recognisers. Exported so a caller can inspect or re-floor the same chain. */
export function screenRecognisers(readers: {
  readonly map: MapPerceiver;
  readonly chest: ChestPerceiver;
}, floor: number = ACTING_CONFIDENCE_FLOOR): Recogniser[] {
  const { map, chest } = readers;
  return [
    { perceiver: chest, floor },
    { perceiver: map, floor },
    { perceiver: new ChestPromptPerceiver(), floor },
    // The item-claim screen comes before the opening: the result banner also clears the opening's
    // gates — live 2026-11-01 it was named `chest-opening` 0.60 and the loop waited on it — while the
    // loot recogniser's caption + AUTO test separates the two.
    { perceiver: new LootPerceiver(), floor },
    // The inn's rest scene (2026-11-07): a defocused inn with the rest caption and the yellow continue
    // mark. It must be named before the chest-opening perceiver, whose gates it used to pass (blurred
    // inn = no HUD text, warm interior = the chest's warm mass), stalling the cycle's rest.
    { perceiver: new InnRestPerceiver(), floor },
    // The opening is named after the prompt: both draw no HUD, and only the prompt's own recogniser
    // can tell the 打开 menu from the lid lifting.
    { perceiver: new ChestOpeningPerceiver(), floor },
    // The main character's death is the game's greyscale scene (2026-11-05): named before anything
    // that keys on the dungeon's own HUD, so a death is never an unnamed frame again.
    { perceiver: new MainCharacterDeathPerceiver(), floor },
    // The character page is a full-screen menu: its X 关闭 tile is the evidence, and it must be named
    // before the HUD can mistake the scene under it for the 3-D view (2026-11-03).
    { perceiver: new CharacterPagePerceiver(), floor },
    { perceiver: new HarkenMenuPerceiver(), floor },
    // The rest town's inn dialog (2026-11-06): its own rows are the evidence, and it must be named
    // before the HUD or the town, or the room rows are walked around instead of pressed.
    { perceiver: new InnPerceiver(), floor },
    // The game's one-off message box (2026-11-06): named before the HUD/town so the panel is answered
    // instead of the screen behind it being steered.
    { perceiver: new MessagePerceiver(), floor },
    // The knowledge base's other pages (2026-11-06): a page whose title the reader knows, named before
    // the HUD so the loop closes it instead of steering the scene behind it. Its own perceiver answers
    // with the catalog's exit, so the World's branch for it is one tap.
    { perceiver: new UiMenuPerceiver(), floor },
    { perceiver: new CombatPerceiver(), floor },
    { perceiver: new HudPerceiver(), floor },
    // The HUD refuses both of these at 0.2; they run last so a dungeon frame never pays for them.
    { perceiver: new WorldMapPerceiver(), floor },
    { perceiver: new TownPerceiver(), floor },
    // The DLL-style list between the world map and the dungeon; named last because only its own
    // row recogniser speaks and a normal frame must not pay for it.
    { perceiver: new DungeonSelectPerceiver(), floor },
    // Last, because the screens it could be confused with are named by recognisers above it: the
    // party member's revive QTE is the battle's modal ring (2026-11-05), and a frame a chest, the
    // list or the dungeon already named must win before this one is asked.
    { perceiver: new ReviveQtePerceiver(), floor },
  ];
}

/**
 * Compose the app's chain: the same order for the app, the CLI and the triage script, differing only
 * in what the caller can supply (a site, an OCR tier, a trust book).
 */
export function createScreenReaders(options: ScreenReadersOptions = {}): ScreenReaders {
  const map = new MapPerceiver(options.readoutOcr, options.site);
  const chest = new ChestPerceiver(options.opener);
  const floor = options.floor ?? ACTING_CONFIDENCE_FLOOR;
  const recognisers = screenRecognisers({ map, chest }, floor);
  const composite = new CompositePerceiver([...recognisers], {
    floorFactor: options.floorFactor ?? (() => 1),
  });
  return { composite, map, chest, recognisers };
}
