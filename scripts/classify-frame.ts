#!/usr/bin/env tsx
/** What does the production compositor make of one saved frame? */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import { MapPerceiver } from '../src/perception/map.ts';
import { ChestPromptPerceiver } from '../src/perception/prompt.ts';
import { ChestOpeningPerceiver } from '../src/perception/chest-opening.ts';
import { LootPerceiver } from '../src/perception/loot.ts';
import { CharacterPagePerceiver } from '../src/perception/character-page.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { DungeonSelectPerceiver } from '../src/perception/dungeon-select.ts';

const file = process.argv[2]!;
const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
const image = { data: decoded.data, width: decoded.width, height: decoded.height };
const frame = { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
const composite = new CompositePerceiver([
  { perceiver: new ChestPerceiver(), floor: 0.5 },
  { perceiver: new MapPerceiver(), floor: 0.5 },
  { perceiver: new ChestPromptPerceiver(), floor: 0.5 },
  { perceiver: new LootPerceiver(), floor: 0.5 },
  { perceiver: new ChestOpeningPerceiver(), floor: 0.5 },
  { perceiver: new CharacterPagePerceiver(), floor: 0.5 },
  { perceiver: new CombatPerceiver(), floor: 0.5 },
  { perceiver: new HudPerceiver(), floor: 0.5 },
  { perceiver: new WorldMapPerceiver(), floor: 0.5 },
  { perceiver: new TownPerceiver(), floor: 0.5 },
  { perceiver: new DungeonSelectPerceiver(), floor: 0.5 },
]);
for (const { perceiver, floor } of [new ChestOpeningPerceiver(), new LootPerceiver(), new ChestPerceiver()].map((p) => ({ perceiver: p, floor: 0.5 }))) {
  const answer = await perceiver.observe(frame as never);
  console.log((perceiver as { constructor: { name: string } }).constructor.name, '->', answer.screen, answer.confidence.toFixed(2), 'floor', floor);
}
const answer = await composite.observe(frame as never);
console.log('composite ->', answer.screen, answer.confidence.toFixed(2));
