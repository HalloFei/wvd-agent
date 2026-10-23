/** The World definition the host's extension loader reads from `src/index.ts`. */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WVD_DEFAULTS, WVD_ID, type WvdConfigSection } from './config.ts';
import { WVD_TOOL_DECLS, WvdWorld } from './world.ts';

export const WVD_DEFINITION: WorldDefinition<WvdConfigSection> = {
  id: WVD_ID,
  label: 'WVD',
  defaults: () => structuredClone(WVD_DEFAULTS),
  // `ctx.cfg` is the live `worlds.wvd` section; each later module maps the keys it owns.
  create: (ctx) => new WvdWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(WVD_TOOL_DECLS, {
      wvd_status: { zh: '报告采集会话是否在运行，以及它此刻在做什么。', en: 'Reports whether a farming session is running and what it is doing.' },
      wvd_look: { zh: '重新截取游戏窗口，把当前画面作为图片返回。', en: 'Captures the game window again and returns the current screen as an image.' },
      wvd_act: { zh: '向游戏窗口发送一次点击或按键，并报告结果。', en: 'Sends one tap or key press to the game window and reports the result.' },
      wvd_resume: { zh: '回答之后让采集循环继续，可附一句说明。', en: 'Lets the farming loop continue after an answer, with an optional note.' },
    }),
    // The skeleton pushes nothing; the loop adds its stuck and stop events with the loop.
    events: [],
  },
};
