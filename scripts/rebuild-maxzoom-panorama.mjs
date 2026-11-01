
/**
 * Rebuild the max-zoom panorama from the saved tiles using a FULL-search NCC between consecutive
 * frames (the scan's own narrow-window estimate was what drifted). Hard-coded: tile order from the
 * manifest, shift per pair, cumulative placement, blended paste.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
const dir = process.argv[2] ?? '.tmp/atlas/maxscan3';
const manifest = JSON.parse(readFileSync(dir + '/manifest.json', 'utf8'));
const frames = manifest.frames.map(f => f.frame);
const STRIP = { x: 480, y: 0, w: 960, h: 1080 };
function gray(path, f) {
  const j = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true });
  const w = Math.floor(960/f), h = Math.floor(1080/f); const d = new Float64Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) { let s=0; for(let dy=0;dy<f;dy++)for(let dx=0;dx<f;dx++){const at=((y*f+dy)*j.width+STRIP.x+x*f+dx)*4;s+=(j.data[at]*299+j.data[at+1]*587+j.data[at+2]*114)/1000;} d[y*w+x]=s/(f*f); }
  return { w, h, d, img: j };
}
function ncc(a, ax, ay, b, bx, by, tw, th) {
  let sa=0,sb=0,saa=0,sbb=0,sab=0,n=0;
  for (let y=0;y<th;y++) for (let x=0;x<tw;x++) { const va=a.d[(ay+y)*a.w+ax+x], vb=b.d[(by+y)*b.w+bx+x]; sa+=va; sb+=vb; saa+=va*va; sbb+=vb*vb; sab+=va*vb; n++; }
  const cov=sab-sa*sb/n, v1=saa-sa*sa/n, v2=sbb-sb*sb/n; return v1<=0||v2<=0?-1:cov/Math.sqrt(v1*v2);
}
function fullShift(A, B, narrow = false) {
  const tw = 40, th = 30;
  const px = Math.floor((A.w-tw)/2), py = Math.floor((A.h-th)/2);
  let best = { s: -2, dx: 0, dy: 0 };
  // a narrow pass assumes the true step is a horizontal pan of up to ~350 px with no vertical drift;
  // the wide pass is the fallback and is the one that can lock onto a wrong peak on this parchment
  const xs = narrow ? 44 : px, ys = narrow ? 5 : py;
  for (let oy=Math.max(-py,-ys); oy<Math.min(B.h-py-th, ys)+1; oy++) for (let ox=Math.max(-px,-xs); ox<Math.min(B.w-px-tw, xs)+1; ox++) {
    const s = ncc(A, px, py, B, px+ox, py+oy, tw, th);
    if (s > best.s) best = { s, dx: ox, dy: oy };
  }
  // refine at 4x
  const A4 = gray(A.path, 4), B4 = gray(B.path, 4);
  const tw4 = 80, th4 = 60;
  const px4 = Math.floor((A4.w-tw4)/2), py4 = Math.floor((A4.h-th4)/2);
  let r = { s: best.s, dx: best.dx*2, dy: best.dy*2 };
  for (let oy=best.dy*2-6; oy<=best.dy*2+6; oy++) for (let ox=best.dx*2-6; ox<=best.dx*2+6; ox++) {
    const bx = px4+ox, by = py4+oy;
    if (bx<0||by<0||bx+tw4>A4.w||by+th4>A4.h) continue;
    const s = ncc(A4, px4, py4, B4, bx, by, tw4, th4);
    if (s > r.s) r = { s, dx: ox, dy: oy };
  }
  return { dx: r.dx*4, dy: r.dy*4, score: Number(r.s.toFixed(3)) };
}
const grays = frames.map(f => { const g = gray(dir + '/' + f, 8); g.path = dir + '/' + f; return g; });
const placements = [{ x: 0, y: 0 }];
for (let i = 1; i < grays.length; i++) {
  let m = fullShift(grays[i-1], grays[i]);
  if (m.score < 0.9) {
    const narrow = fullShift(grays[i-1], grays[i], true);
    if (narrow.score > m.score) m = narrow;
  }
  placements.push({ x: placements[i-1].x - m.dx, y: placements[i-1].y - m.dy, score: m.score, shift: m });
  console.log(frames[i], 'shift', m.dx, m.dy, 'score', m.score, 'placement', placements[i].x, placements[i].y);
}
const xs = placements.map(p => p.x), ys = placements.map(p => p.y);
const minX = Math.min(...xs), minY = Math.min(...ys);
const W = Math.max(...xs) - minX + 960, H = Math.max(...ys) - minY + 1080;
const acc = new Float64Array(W * H * 3), weight = new Float64Array(W * H);
frames.forEach((f, i) => {
  const img = jpeg.decode(readFileSync(dir + '/' + f), { useTArray: true, formatAsRGBA: true });
  const ox = placements[i].x - minX, oy = placements[i].y - minY;
  for (let y = 0; y < 1080; y++) for (let x = 0; x < 960; x++) {
    if (y > 950) continue;
    const edge = Math.min(x, 960-x, y, 1080-y);
    if (edge < 14) continue;
    const si = (y * img.width + 480 + x) * 4;
    const di = (oy + y) * W + (ox + x);
    acc[di*3] += img.data[si]; acc[di*3+1] += img.data[si+1]; acc[di*3+2] += img.data[si+2];
    weight[di] += 1;
  }
});
const header = Buffer.from('P6\n' + W + ' ' + H + '\n255\n');
const body = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) if (weight[i] > 0) { body[i*3] = acc[i*3]/weight[i]; body[i*3+1] = acc[i*3+1]/weight[i]; body[i*3+2] = acc[i*3+2]/weight[i]; }
writeFileSync(dir + '/band.ppm', Buffer.concat([header, body]));
let covered = 0; for (let i = 0; i < W*H; i++) if (weight[i] > 0) covered++;
console.log(JSON.stringify({ tiles: frames.length, W, H, coverage: +(covered/(W*H)).toFixed(3) }));
