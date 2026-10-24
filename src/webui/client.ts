/**
 * The WVD console page: one panel, `wvd-console`, drawn from the World's typed surface (plan Task
 * 13, design §6). Everything here is a view of `status` and `log`; the page decides nothing about
 * the farm and can never send input.
 *
 * The socket pushes a whole snapshot at a time; between pushes the page ages the last one on its own
 * clock, so the frame age and the question's countdown keep moving during the pause. A dropped
 * socket changes nothing about the session: the page says so, and re-reads `status` before trusting
 * the next push.
 */
import type {
  WebUiClientBundle,
  WebUiLog,
  WebUiLogTone,
  WebUiPanel,
  WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';
import type { ConsoleFrame, ConsoleLogEntry, ConsoleLogKind, ConsoleResult, ConsoleStatus } from './protocol.ts';
import { CONSOLE_LOG_LIMIT, CONSOLE_PANEL_ID } from './protocol.ts';

/** How often the page refreshes what pushes cannot carry: the log, and the status when offline. */
const TICK_MS = 1000;
/** The log survives a night of farm transitions; the server keeps 50, the page shows all of them. */
const LOG_TONE: Partial<Record<ConsoleLogKind, WebUiLogTone>> = { cancelled: 'dim', undelivered: 'dim' };

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function seconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${Math.max(0, Math.round(ms / 1000))} s`;
}

function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

const wvdConsole: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({
      title: 'WVD console',
      en: 'wvd',
      desc: 'The session state, the live strip, the open question and the recent log.',
    });
    root.appendChild(card.el);

    // Header: the lamp, the state word, and why.
    const header = ui.rowbar();
    const lamp = ui.h('span', 'wvd-lamp');
    const state = ui.h('strong', 'wvd-state', 'offline');
    const detail = ui.h('span', 'wvd-detail');
    const connection = ui.h('span', 'wvd-connection', 'connecting…');
    header.append(lamp, state, detail, connection);

    // The live strip: only what the loop already measured. Each value cell is kept by name.
    const cell = (): HTMLElement => ui.h('span', 'wvd-value', '—');
    const cells = {
      screen: cell(),
      floor: cell(),
      position: cell(),
      chests: cell(),
      intent: cell(),
      escalations: cell(),
      frameAge: cell(),
    };
    const strip = ui.kv([
      { k: 'screen', v: cells.screen },
      { k: 'floor', v: cells.floor },
      { k: 'position', v: cells.position },
      { k: 'chests left', v: cells.chests },
      { k: 'intent', v: cells.intent },
      { k: 'escalations', v: cells.escalations },
      { k: 'frame age', v: cells.frameAge },
    ]);
    strip.classList.add('wvd-strip');

    // The open question: only while escalating.
    const questionBox = ui.h('div', 'wvd-question');
    const questionText = ui.h('p', 'wvd-questiontext');
    const questionMeta = ui.h('p', 'wvd-questionmeta');
    const cancel = ui.button('Cancel question', { size: 'sm' });
    questionBox.append(questionText, questionMeta, cancel);

    // Controls. Stop is always enabled: the panel is a convenience, the hotkey is the last resort.
    const controls = ui.rowbar();
    const start = ui.button('Start', { variant: 'primary' });
    const stop = ui.button('Stop');
    const hint = ui.h('span', 'wvd-hint');
    const message = ui.msgline('');
    controls.append(start, stop, hint);

    const log: WebUiLog = ui.log({ max: CONSOLE_LOG_LIMIT, empty: 'no transitions yet' });

    card.body.append(header, strip, questionBox, controls, message, ui.section('Recent transitions'), log.el);

    let last: ConsoleStatus | null = null;
    let receivedAt = 0;
    let connected = false;
    let logSignature = '';

    const age = (ms: number | null): number | null => (ms === null ? null : ms + (performance.now() - receivedAt));

    const renderQuestion = (status: ConsoleStatus): void => {
      const question = status.question;
      questionBox.hidden = question === null;
      if (question === null) return;
      // The countdown shrinks between pushes: it is drawn from the snapshot plus the page's clock.
      const elapsed = status.nowMs - question.askedAtMs + (performance.now() - receivedAt);
      questionText.textContent = question.text;
      questionMeta.textContent = `asked ${seconds(elapsed)} ago · ${seconds(Math.max(0, question.timeoutMs - elapsed))} left`;
    };

    /** The strip, drawn from one snapshot. Ages use the page's clock against when it arrived. */
    const renderStrip = (status: ConsoleStatus): void => {
      cells.screen.textContent = status.screen ?? '—';
      cells.floor.textContent = status.floor ?? '—';
      cells.position.textContent = status.x === null || status.y === null ? '—' : `${status.x} / ${status.y}`;
      cells.chests.textContent = status.chestsLeft === null ? '—' : String(status.chestsLeft);
      // Tick health: how old the decision is, next to how old the frame is.
      cells.intent.textContent = status.intent === null
        ? '—'
        : `${status.intent} · ${seconds(age(status.intentAgeMs))} ago`;
      cells.escalations.textContent = `${status.escalationsThisHour}/${status.escalateMaxPerHour}`;
      cells.frameAge.textContent = seconds(age(status.frameAgeMs));
    };

    const render = (status: ConsoleStatus): void => {
      last = status;
      receivedAt = performance.now();
      lamp.className = `wvd-lamp ${status.lamp}`;
      state.textContent = status.state;
      detail.textContent = status.detail ?? '';
      detail.title = status.detail ?? '';
      renderStrip(status);
      renderQuestion(status);
      start.disabled = !status.canStart.ok;
      start.title = status.canStart.ok ? '' : status.canStart.reason;
      hint.textContent = status.canStart.ok ? '' : status.canStart.reason;
      cancel.disabled = !status.canCancel;
    };

    /** Between pushes, age what is already drawn; nothing here talks to the server. */
    const ageOnly = (): void => {
      if (last === null) return;
      renderStrip(last);
      renderQuestion(last);
    };

    const renderLog = (entries: readonly ConsoleLogEntry[]): void => {
      const signature = entries.map((entry) => `${entry.atMs}:${entry.kind}:${entry.text}`).join('|');
      if (signature === logSignature) return;
      logSignature = signature;
      log.clear();
      for (const entry of entries) log.append(`${clock(entry.at)}  ${entry.text}`, LOG_TONE[entry.kind] ?? 'plain');
    };

    const settle = (result: ConsoleResult<ConsoleStatus>, method: string): void => {
      if (result.ok) {
        message.textContent = '';
        message.classList.remove('bad');
        render(result.value);
        return;
      }
      // A refused start says why beside the button; a refused stop has nothing to add.
      message.textContent = `${method}: ${result.error}`;
      message.classList.add('bad');
    };

    const invoke = async <T>(method: string): Promise<T | null> => {
      try {
        return await ctx.invoke<T>(method);
      } catch (error) {
        message.textContent = errText(error);
        message.classList.add('bad');
        return null;
      }
    };

    const refresh = async (): Promise<void> => {
      const status = await invoke<ConsoleResult<ConsoleStatus>>('status');
      if (status) {
        if (status.ok) render(status.value);
        else settle(status, 'status');
      }
      const entries = await invoke<ConsoleResult<readonly ConsoleLogEntry[]>>('log');
      if (entries) {
        if (entries.ok) renderLog(entries.value);
        else settle(entries, 'log');
      }
    };

    const run = (method: string) => async (): Promise<void> => {
      const result = await invoke<ConsoleResult<ConsoleStatus>>(method);
      if (result) settle(result, method);
      const entries = await invoke<ConsoleResult<readonly ConsoleLogEntry[]>>('log');
      if (entries?.ok) renderLog(entries.value);
      if (!connected) void refresh();
    };

    start.addEventListener('click', () => void run('start')());
    stop.addEventListener('click', () => void run('stop')());
    cancel.addEventListener('click', () => void run('cancel-escalation')());

    ctx.stream({
      message: (text: string) => {
        try {
          const frame = JSON.parse(text) as ConsoleFrame;
          if (frame.type === 'status') render(frame.value);
        } catch {
          message.textContent = 'the console received a frame it could not read';
          message.classList.add('bad');
        }
      },
      open: () => {
        connected = true;
        connection.textContent = 'live';
        connection.classList.add('on');
        // Re-read before trusting any push: the page may have been away while the farm moved.
        void refresh();
      },
      close: () => {
        connected = false;
        connection.textContent = 'reconnecting…';
        connection.classList.remove('on');
      },
    });

    // One second of local ageing, and a read-only re-read when pushes carry nothing.
    let ticks = 0;
    ctx.interval(() => {
      ticks += 1;
      ageOnly();
      if (!connected) void refresh();
      else if (ticks % 5 === 0) void invoke<ConsoleResult<readonly ConsoleLogEntry[]>>('log').then((entries) => {
        if (entries?.ok) renderLog(entries.value);
      });
    }, TICK_MS);

    void refresh();
    cancel.disabled = true;
  },
};

const bundle: WebUiClientBundle = { panels: { [CONSOLE_PANEL_ID]: wvdConsole } };
export default bundle;
