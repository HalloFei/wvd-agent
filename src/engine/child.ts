/**
 * The World side of the engine child: spawn it, and speak contracts §5 to it over stdin/stdout.
 *
 * The child is plain ESM (`./child.mjs`) spawned with `process.execPath` and
 * `ELECTRON_RUN_AS_NODE=1`, so it starts under the app's Electron-as-Node and under a plain
 * `node` alike (R9). Every Win32 call lives in that process; here there is only the pipe.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ActionFailure, EngineReply, EngineRequest } from '../contracts.ts';
import { LineDecoder, decodeLine, encodeRequest, type EngineEvent } from './protocol.ts';

export interface EngineOptions {
  /** The window the child captures and guards; the World's `gameWindowTitle`. */
  title: string;
  /** Global stop hotkey, e.g. `Ctrl+Alt+W`; an empty string disables registration. */
  hotkey?: string;
  /** JPEG quality, `jpegQuality`. */
  jpegQuality?: number;
}

/** The engine's request surface, as the rest of the World sees it. */
export interface EngineClient {
  readonly child: ChildProcess;
  /** One §5 request; never rejects — a failure is a §5 reply (`unavailable`, `rejected` or `timeout`). */
  request(request: EngineRequest): Promise<EngineReply>;
  /** The child's unsolicited messages, the stop hotkey (R3); the returned function unsubscribes. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  /** Ends the pipe and the process; pending requests fail with `unavailable`. */
  close(): void;
}

const CHILD = fileURLToPath(new URL('./child.mjs', import.meta.url));

/** Spawns the engine child; `connectEngine` turns it into the protocol client. */
export function startEngine(options: EngineOptions): ChildProcess {
  const args = [CHILD, `--title=${options.title}`];
  if (options.hotkey !== undefined) args.push(`--hotkey=${options.hotkey}`);
  if (options.jpegQuality !== undefined) args.push(`--quality=${options.jpegQuality}`);
  return spawn(process.execPath, args, {
    // Electron's binary runs as Node only with this set; plain Node ignores the variable.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Wraps a spawned child in the request/reply client. */
export function connectEngine(child: ChildProcess, options: { timeoutMs?: number } = {}): EngineClient {
  const timeoutMs = options.timeoutMs ?? 5000;
  const stdout = child.stdout;
  if (!stdout) throw new Error('engine child was spawned without a stdout pipe');
  const stdin = child.stdin;

  const pending = new Map<number, { resolve(reply: EngineReply): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: EngineEvent) => void>();
  let nextId = 1;
  let closed = false;

  const settle = (reply: EngineReply): void => {
    const entry = pending.get(reply.id);
    if (!entry) return; // a reply for a request that already timed out
    clearTimeout(entry.timer);
    pending.delete(reply.id);
    entry.resolve(reply);
  };

  const failAll = (error: ActionFailure, detail: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, ok: false, error, detail });
    }
    pending.clear();
  };

  const decoder = new LineDecoder();
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      const message = decodeLine(line);
      if (!message) continue;
      if ('reply' in message) settle(message.reply);
      else if ('event' in message) for (const listener of listeners) listener(message.event);
    }
  });
  // the child's log is not the protocol; draining it keeps a full stderr pipe from blocking it
  child.stderr?.resume();
  child.on('error', () => failAll('unavailable', 'engine-error'));
  child.on('close', () => {
    closed = true;
    failAll('unavailable', 'engine-exited');
  });
  stdin?.on('error', () => {
    // EPIPE reaches the pending request as a timeout or as the close above
  });

  return {
    child,
    request(request) {
      const id = nextId++;
      if (closed || !stdin) return Promise.resolve({ id, ok: false, error: 'unavailable', detail: 'engine-closed' });
      return new Promise<EngineReply>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          resolve({ id, ok: false, error: 'timeout', detail: `after ${timeoutMs}ms` });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        try {
          stdin.write(encodeRequest(id, request));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ id, ok: false, error: 'unavailable', detail: 'engine-write' });
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      failAll('unavailable', 'engine-closed');
      try {
        stdin?.end();
      } catch {
        // already closed
      }
      child.kill();
    },
  };
}
