#!/usr/bin/env node
/**
 * What does the **production** chain make of one saved frame?
 *
 * This script exists for triage, and it used to answer with its own shorter reader set — twelve
 * recognisers against the app's eighteen, no site descriptor, no trust book. On 2026-11-08 a saved
 * frame of the character page answered `character-page 0.97` here while the app named the same
 * instant `dungeon 0.80`; the tool was measuring a chain the loop does not run. It now composes the
 * one chain (`src/perception/reader-set.ts`), with the site descriptor the app passes, so the answer
 * is the loop's answer.
 *
 * It reads the refusal ledger's PNGs as well as JPEGs. That is the point of the lossless frame: the
 * loop saw raw pixels, a q75 snapshot hides the detail a gate measured, and a PNG carries the same
 * bytes — so a file on disk reproduces a live refusal exactly.
 *
 * Usage:  scripts/classify-frame.ts <frame.png|frame.jpeg> [...]
 * Prints, per file: the answer, every screen's standing (and whether the frame rules it out), and
 * what each recogniser said on its own.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { decodePng } from '../src/perception/ledger.ts';
import { createScreenReaders } from '../src/perception/reader-set.ts';
import { FFXI_GCN } from '../src/perception/sites/ffxi-gcn.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: classify-frame.ts <frame.png|frame.jpeg> [...]');
  process.exit(2);
}

/** A frame from a file: the same interface the loop hands a classifier. */
function readFrame(path: string): Frame {
  const bytes = readFileSync(path);
  let image: RgbaImage;
  if (path.toLowerCase().endsWith('.png')) {
    image = decodePng(bytes);
  } else {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    image = { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  }
  let cached: Promise<RgbaImage> | undefined;
  return {
    atMs: 0,
    width: image.width,
    height: image.height,
    toRgba: () => (cached ??= Promise.resolve(image)),
  };
}

const { composite, recognisers } = createScreenReaders({ site: FFXI_GCN });

for (const path of files) {
  const frame = readFrame(path);
  const classification = await composite.classify(frame);
  console.log(`\n== ${path}`);
  console.log(`   answer  ${classification.answer.screen} ${classification.answer.confidence.toFixed(2)}`);
  for (const standing of classification.standings) {
    const mark = standing.ruledOut ? 'ruled out' : 'standing ';
    console.log(`   ${standing.screen.padEnd(18)} ${mark}  support ${standing.support.toFixed(2)}`);
  }
  for (const { perceiver, floor } of recognisers) {
    const name = (perceiver as { constructor: { name: string } }).constructor.name;
    const observation = await perceiver.observe(frame);
    const accepted = observation.confidence >= floor ? '  ' : '( )';
    console.log(`   ${accepted} ${name.padEnd(30)} ${observation.screen.padEnd(16)} ${observation.confidence.toFixed(2)}`);
  }
}
