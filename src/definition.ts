/** The World definition the host's extension loader reads from `src/index.ts`. */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WVD_DEFAULTS, WVD_ID, type WvdConfigSection } from './config.ts';
import { createWvdWorld } from './main.ts';
import { WVD_TOOL_DECLS } from './world.ts';

export const WVD_DEFINITION: WorldDefinition<WvdConfigSection> = {
  id: WVD_ID,
  label: 'WVD',
  defaults: () => structuredClone(WVD_DEFAULTS),
  // `ctx.cfg` is the live `worlds.wvd` section; the composition root maps it onto the modules, and
  // nothing is spawned until the operator starts a session.
  create: (ctx) => createWvdWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(WVD_TOOL_DECLS, {
      wvd_status: { zh: '报告采集会话是否在运行、它最后一次决定，以及升级额度还剩多少。', en: 'Reports whether a farming session is running, what it last decided, and the escalation budget left.' },
      wvd_look: { zh: '重新截取游戏窗口，把当前画面作为图片返回。', en: 'Captures the game window again and returns the current screen as an image.' },
      wvd_act: { zh: '在问题等待回答时，向游戏窗口发送一次点击或按键。', en: 'Sends one tap or held key to the game window while a question is waiting.' },
      wvd_resume: { zh: '回答问题并让采集循环继续，可附上循环接下来要做的动作。', en: 'Answers the question and lets the loop run again, optionally with the intent it should take.' },
    }),
    // The two events the loop pushes (`src/escalation/event.ts`). The trigger here documents the
    // market; the loop passes `trigger:'flush'` explicitly on every push.
    events: [
      {
        type: 'wvd.stuck',
        description: {
          zh: '采集循环暂停，等 Coo 回答；带一枚当时的画面与一个问题。',
          en: 'The farm loop is paused waiting for an answer; carries the frame and one question.',
        },
        trigger: 'flush',
        tags: ['snapshot'],
      },
      {
        type: 'wvd.stopped',
        description: {
          zh: '采集会话已停止，以及停止的原因。',
          en: 'The farming session has stopped, and why.',
        },
        trigger: 'flush',
        tags: ['snapshot'],
      },
    ],
  },
};
