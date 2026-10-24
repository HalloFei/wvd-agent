import { describe, expect, it } from 'vitest';
import { createGestures, inputAcknowledgement, Refused } from '../src/engine/gestures.mjs';

/** A device that records what the gesture rules asked it to do. */
class FakeDevice {
  readonly events: string[] = [];
  checks = 0;
  foregroundFor: number[] = [];
  sleep: (ms: number) => Promise<void> = async () => {};

  isForeground(): boolean {
    const check = this.checks++;
    return this.foregroundFor.includes(check);
  }
  moveToClient(_hwnd: number, x: number, y: number): void { this.events.push(`move:${x},${y}`); }
  mouseDown(): void { this.events.push('down'); }
  mouseUp(): void { this.events.push('up'); }
  keyDown(scan: number): void { this.events.push(`keydown:${scan}`); }
  keyUp(scan: number): void { this.events.push(`keyup:${scan}`); }
}

describe('input gestures (R21)', () => {
  it('asserts the foreground before the down and sends nothing when refused', async () => {
    const device = new FakeDevice();
    device.foregroundFor = []; // every check says "not foreground"
    const gestures = createGestures(device);

    await expect(gestures.tap(1, 10, 20, 1)).rejects.toBeInstanceOf(Refused);

    expect(device.events).toEqual([]);
    expect(gestures.heldButtons()).toEqual({ mouse: 0, keys: [] });
  });

  it('completes the release and reports rejected when the window moved mid-press', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0]; // before the down: foreground; after the up: gone
    const gestures = createGestures(device);

    await expect(gestures.tap(1, 10, 20, 1)).rejects.toBeInstanceOf(Refused);

    expect(device.events).toEqual(['move:10,20', 'down', 'up']);
    expect(gestures.heldButtons()).toEqual({ mouse: 0, keys: [] });
  });

  it('refuses the second click when the window loses focus between clicks', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1]; // click 1 passes; click 2's pre-down guard fails
    const gestures = createGestures(device);

    await expect(gestures.tap(1, 5, 6, 2)).rejects.toBeInstanceOf(Refused);

    // one press then a refusal: deleting the per-click guard would make this two clicks and resolve
    expect(device.events).toEqual(['move:5,6', 'down', 'up']);
  });

  it('completes both clicks of a double tap while the window holds', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1, 2, 3];
    const gestures = createGestures(device);

    await gestures.tap(1, 5, 6, 2);

    expect(device.events).toEqual(['move:5,6', 'down', 'up', 'move:5,6', 'down', 'up']);
    expect(gestures.heldButtons()).toEqual({ mouse: 0, keys: [] });
  });

  it('asserts the foreground before a hold and sends nothing when refused', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [];
    const gestures = createGestures(device);

    await expect(gestures.holdKey(1, 0x1e, 60)).rejects.toBeInstanceOf(Refused);

    expect(device.events).toEqual([]);
  });

  it('holds a key, releases it, and reports rejected when the window moved during the hold', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0]; // guard passes, post-release check fails
    const gestures = createGestures(device);

    await expect(gestures.holdKey(1, 0x1e, 60)).rejects.toBeInstanceOf(Refused);

    expect(device.events).toEqual(['keydown:30', 'keyup:30']);
  });

  it('releaseHeld releases a key that is still down, exactly once (holdKey cancellation)', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1];
    let resume!: () => void;
    device.sleep = () => new Promise((resolve) => { resume = resolve; });
    const gestures = createGestures(device);

    const holding = gestures.holdKey(1, 0x1e, 60);
    await Promise.resolve();
    expect(gestures.heldButtons()).toEqual({ mouse: 0, keys: [0x1e] });

    gestures.releaseHeld();
    expect(device.events).toEqual(['keydown:30', 'keyup:30']);
    expect(gestures.heldButtons()).toEqual({ mouse: 0, keys: [] });

    resume();
    await expect(holding).resolves.toBeUndefined();
    // the finally does not send a second release for something releaseHeld already released
    expect(device.events.filter((event) => event === 'keyup:30')).toHaveLength(1);
  });

  it('releaseHeld releases a mouse button that is still down', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1];
    let resume!: () => void;
    device.sleep = () => new Promise((resolve) => { resume = resolve; });
    const gestures = createGestures(device);

    const tapping = gestures.tap(1, 1, 2, 1);
    await Promise.resolve();
    expect(gestures.heldButtons().mouse).toBe(1);

    gestures.releaseHeld();
    expect(device.events).toEqual(['move:1,2', 'down', 'up']);
    expect(gestures.heldButtons().mouse).toBe(0);

    resume();
    await expect(tapping).resolves.toBeUndefined();
    expect(device.events.filter((event) => event === 'up')).toHaveLength(1);
  });
});

describe('drag gesture', () => {
  it('moves to the start, presses, walks the line and releases once', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1];
    const gestures = createGestures(device);

    await gestures.drag(1, 100, 200, 500, 200, 300);

    expect(device.events[0]).toBe('move:100,200');
    expect(device.events[1]).toBe('down');
    expect(device.events.at(-1)).toBe('up');
    expect(device.events.filter((event) => event === 'down')).toHaveLength(1);
    expect(device.events.filter((event) => event === 'up')).toHaveLength(1);
    // the last move lands on the destination before the release
    expect(device.events.at(-2)).toBe('move:500,200');
    expect(gestures.heldButtons()).toEqual({ mouse: 0, keys: [] });
  });

  it('releases and reports rejected when the window leaves mid-drag', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0]; // the pre-down guard passes, the post-release one fails
    const gestures = createGestures(device);

    await expect(gestures.drag(1, 0, 0, 100, 0, 100)).rejects.toBeInstanceOf(Refused);

    expect(device.events[0]).toBe('move:0,0');
    expect(device.events[1]).toBe('down');
    expect(device.events.at(-1)).toBe('up');
    expect(gestures.heldButtons().mouse).toBe(0);
  });

  it('caps a long drag at the ceiling and a short one at the floor', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1, 2, 3];
    const gestures = createGestures(device);

    await gestures.drag(1, 0, 0, 0, 0, 10_000);
    const longMoves = device.events.filter((event) => event.startsWith('move:')).length;
    expect(longMoves).toBeGreaterThanOrEqual(5);
    expect(longMoves).toBeLessThanOrEqual(21);

    device.events.length = 0;
    await gestures.drag(1, 0, 0, 10, 0, 1);
    const shortMoves = device.events.filter((event) => event.startsWith('move:')).length;
    expect(shortMoves).toBeGreaterThanOrEqual(4);
    expect(shortMoves).toBeLessThanOrEqual(6);
  });

  it('releaseHeld releases a drag in flight exactly once', async () => {
    const device = new FakeDevice();
    device.foregroundFor = [0, 1];
    let resume!: () => void;
    let released = false;
    device.sleep = () => (released
      ? Promise.resolve()
      : new Promise((resolve) => { resume = () => { released = true; resolve(); }; }));
    const gestures = createGestures(device);

    const dragging = gestures.drag(1, 1, 2, 50, 60, 200);
    await Promise.resolve();
    expect(gestures.heldButtons().mouse).toBe(1);

    gestures.releaseHeld();
    expect(gestures.heldButtons().mouse).toBe(0);
    expect(device.events.filter((event) => event === 'up')).toHaveLength(1);

    resume();
    await expect(dragging).resolves.toBeUndefined();
    expect(device.events.filter((event) => event === 'up')).toHaveLength(1);
  });
});

describe('input acknowledgement (R20b)', () => {
  it('reports the measured leg from request receipt on the child clock', () => {
    expect(inputAcknowledgement(100, () => 173.5)).toEqual({ inputMs: 73.5 });
    expect(inputAcknowledgement(500, () => 500)).toEqual({ inputMs: 0 });
  });
});
