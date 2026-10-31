import { describe, expect, it } from 'vitest';
import { StabilityGate, waitStable } from '../src/frames/stable.ts';

describe('stable-frame guard', () => {
  it('holds a key for holdMs on the samples own clock', () => {
    const gate = new StabilityGate<string>({ key: (value) => value, holdMs: 300 });
    expect(gate.push('a', 0).stable).toBe(false);
    expect(gate.push('a', 100).stable).toBe(false);
    expect(gate.push('b', 200).stable).toBe(false);
    expect(gate.push('b', 499).stable).toBe(false);
    expect(gate.push('b', 500).stable).toBe(true);
  });

  it('a stale atMs resets the window instead of counting backwards', () => {
    const gate = new StabilityGate<string>({ key: (value) => value, holdMs: 300 });
    gate.push('a', 500);
    const stale = gate.push('a', 400);
    expect(stale.stable).toBe(false);
    expect(stale.stableForMs).toBe(0);
    const later = gate.push('a', 800);
    expect(later.stable).toBe(true);
  });

  it('holdMs zero is stable on the first sample', () => {
    const gate = new StabilityGate<string>({ key: (value) => value, holdMs: 0 });
    expect(gate.push('a', 0).stable).toBe(true);
  });

  it('waitStable waits through a flicker and returns the settled value', async () => {
    let clock = 0;
    let index = 0;
    const values = ['town', 'unknown', 'town', 'town', 'town', 'town'];
    const result = await waitStable({
      sample: async () => ({ value: values[index++]!, atMs: clock }),
      key: (value) => value,
      holdMs: 300,
      timeoutMs: 2_000,
      pollMs: 100,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(result.stable).toBe(true);
    if (result.stable) {
      expect(result.value).toBe('town');
      expect(result.atMs).toBe(500);
    }
  });

  it('waitStable returns the last value on timeout', async () => {
    let clock = 0;
    const result = await waitStable({
      sample: async () => {
        const value = clock % 200 === 0 ? 'a' : 'b';
        return { value, atMs: clock };
      },
      key: (value) => value,
      holdMs: 300,
      timeoutMs: 300,
      pollMs: 100,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(result.stable).toBe(false);
    if (!result.stable) {
      expect(result.reason).toBe('timeout');
      expect(result.value).not.toBeNull();
    }
  });

  it('waitStable reports a cancelled wait without sampling', async () => {
    const controller = new AbortController();
    controller.abort();
    let sampled = false;
    const result = await waitStable({
      sample: async () => { sampled = true; return { value: 'a', atMs: 0 }; },
      key: (value) => value,
      holdMs: 100,
      timeoutMs: 1_000,
      pollMs: 100,
      wait: async () => {},
      now: () => 0,
      abort: controller.signal,
    });
    expect(result.stable).toBe(false);
    if (!result.stable) expect(result.reason).toBe('cancelled');
    expect(sampled).toBe(false);
  });

  it('waitStable reports a sampler failure as a value', async () => {
    const result = await waitStable<string>({
      sample: async () => { throw new Error('stale-frame'); },
      key: (value) => value,
      holdMs: 100,
      timeoutMs: 1_000,
      pollMs: 100,
      wait: async () => {},
      now: () => 0,
    });
    expect(result.stable).toBe(false);
    if (!result.stable) {
      expect(result.reason).toBe('sample-failed');
      expect(result.detail).toContain('stale-frame');
    }
  });

  it('refuses invalid options as a value', async () => {
    const result = await waitStable({
      sample: async () => ({ value: 'a', atMs: 0 }),
      key: (value) => value,
      holdMs: 100,
      timeoutMs: 0,
      pollMs: 100,
      wait: async () => {},
      now: () => 0,
    });
    expect(result.stable).toBe(false);
    if (!result.stable) expect(result.reason).toBe('sample-failed');
  });
});
