#!/usr/bin/env tsx
/**
 * What does the knowledge base make of this frame?
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/ui-read.ts .tmp/ui/frame.jpg
 *
 * Prints the page the reader named, its score and the exit the catalog carries for it; `match: null`
 * means no catalogued page is on the frame. The read-only half of the UI probe: it never taps.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { findUiMenu } from '../src/ui/menu.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: ui-read.ts <frame.jpg>');
const raw = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
const match = findUiMenu({ data: raw.data, width: raw.width, height: raw.height });
console.log(JSON.stringify({ ok: true, file, size: [raw.width, raw.height], match }, null, 0));
