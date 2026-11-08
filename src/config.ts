/** Config section `worlds.wvd`, its defaults and the console config group (contracts §8). */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';
import { MAX_CAPTURE_WIDTH, MIN_CAPTURE_WIDTH } from './engine/protocol.ts';

export const WVD_ID = 'wvd';

export interface WvdConfigSection extends WorldSection {
  dryRun: boolean;
  tickMs: number;
  sessionMaxMinutes: number;
  /** How many enter → farm → leave cycles one session runs (design §7.8). */
  cycles: number;
  /**
   * End the session on a death (the main character's scene, or a party member's revive QTE) instead
   * of asking Coo. Off by default: the question is the operator's. An unattended farm run turns it
   * on so the stop is a stop, not a wait for an answer nobody is there to give.
   */
  stopOnDeath: boolean;
  /** The room the party takes at an inn; a room the dialog does not offer falls back to 标准房. */
  innRoom: string;
  /**
   * The cycle heal's frequency: heal after every Nth completed battle. `0` never heals on battle,
   * `1` is every battle, `N` is every Nth (the operator's matrix, 2026-11-09).
   */
  healAfterBattles: number;
  /** The same for chests: `0` never, `1` every chest, `N` every Nth. */
  healAfterChests: number;
  /** Heal on the first settled view on the farm floor of a cycle (legacy `RECOVER_WHEN_BEGINNING`). */
  healOnEntry: boolean;
  /** Heal on the first settled view after a rest (legacy `RECOVER_AFTER_REST`). */
  healAfterRest: boolean;
  /** Task file for the location to farm; empty keeps the built-in route (contracts §10). */
  taskFile: string;
  stallStopSeconds: number;
  gameWindowTitle: string;
  jpegQuality: number;
  engineTimeoutMs: number;
  pressHoldMs: number;
  escalationImageWidth: number;
  mapOpenTimeoutMs: number;
  /** How long the 由谁打开? panel may take to answer the 打开 click, milliseconds. */
  openerPanelTimeoutMs: number;
  automoveArrivalTimeoutMs: number;
  automoveStillSeconds: number;
  hazardEscapeSteps: number;
  hazardEscapeHoldMs: number;
  resumeMaxAttempts: number;
  willpowerFloor: number;
  maxRerolls: number;
  rerollLeadRatio: number;
  qteLatencyMs: number;
  /**
   * The slide time a bar's **first** press is planned with, seconds (2026-11-06): the median of the
   * recorded parks, 0.05 s. After a press the bar's own measured park replaces it. There is no brake
   * switch or deceleration constant — the plan's one slide term is a measured time.
   */
  qtePriorCarryTauS: number;
  qteAttemptsFallback: number;
  /** How long the QTE timing sub-loop may hold the tick before it gives up, milliseconds. */
  qteSubLoopMs: number;
  lootTapIntervalMs: number;
  lootTapMax: number;
  autoBattleEnableAttempts: number;
  /** How long one battle operation waits after the previous tap returns, milliseconds (§8.5). */
  battleStepMs: number;
  /** How long after the battle's first frame before the first press, milliseconds. */
  battleSettleMs: number;
  /**
   * How long the opener may wait for a **confirmed** turn card (the same ACTIVE member on consecutive
   * frames) before the cast is given up, milliseconds.
   */
  battleOpenerTimeoutMs: number;
  fightTimeoutMs: number;
  escalateMaxPerHour: number;
  escalateTimeoutMs: number;
  /** How long an unnamed screen must persist before the loop asks about it, milliseconds. */
  escalateSettleMs: number;
  stopHotkey: string;
}

export const WVD_DEFAULTS: WvdConfigSection = {
  enabled: false,
  dryRun: false,
  tickMs: 100,
  sessionMaxMinutes: 120,
  cycles: 1,
  stopOnDeath: false,
  innRoom: '标准房',
  // The operator's matrix (2026-11-09): every battle and every chest, no entry/rest heal — today's
  // behaviour as a config value, so a run can be turned down to `0,0` or up to every Nth without code.
  healAfterBattles: 1,
  healAfterChests: 1,
  healOnEntry: false,
  healAfterRest: false,
  taskFile: '',
  stallStopSeconds: 120,
  gameWindowTitle: 'WizardryVariantsDaphne',
  jpegQuality: 75,
  engineTimeoutMs: 5000,
  pressHoldMs: 60,
  escalationImageWidth: 1280,
  mapOpenTimeoutMs: 3000,
  openerPanelTimeoutMs: 10000,
  automoveArrivalTimeoutMs: 120000,
  automoveStillSeconds: 5,
  hazardEscapeSteps: 3,
  hazardEscapeHoldMs: 250,
  resumeMaxAttempts: 2,
  willpowerFloor: 60,
  maxRerolls: 5,
  rerollLeadRatio: 0.5,
  // The measured input leg: 61–76 ms over the 2026-11-04/05 presses (median 63.5), so 64.
  qteLatencyMs: 64,
  qtePriorCarryTauS: 0.05,
  qteAttemptsFallback: 2,
  qteSubLoopMs: 4000,
  lootTapIntervalMs: 400,
  lootTapMax: 10,
  autoBattleEnableAttempts: 3,
  battleStepMs: 1000,
  battleSettleMs: 1000,
  battleOpenerTimeoutMs: 10000,
  fightTimeoutMs: 180000,
  escalateMaxPerHour: 20,
  escalateTimeoutMs: 90000,
  escalateSettleMs: 5000,
  stopHotkey: 'Ctrl+Alt+W',
};

/** Every tunable of contracts §8, as one group the console renders. */
export const WVD_CONFIG_GROUP: ConfigGroup = {
  id: 'world:wvd',
  owner: 'world:wvd',
  schema: {
    type: 'object',
    title: 'WVD',
    description: '捕获窗口、寻路、宝箱与升级的配置。',
    properties: {
      'worlds.wvd.enabled': {
        type: 'boolean', title: '启用', description: '主开关。',
      },
      'worlds.wvd.dryRun': {
        type: 'boolean', title: '演练', description: '只记录要做的操作，不发送输入。',
      },
      'worlds.wvd.tickMs': {
        type: 'integer', title: '循环周期', description: '每一步之间的间隔，毫秒。', minimum: 50, maximum: 1000,
      },
      'worlds.wvd.sessionMaxMinutes': {
        type: 'integer', title: '会话上限', description: '一次会话到点强制停止，分钟。',
      },
      'worlds.wvd.cycles': {
        type: 'integer', title: '循环次数',
        description: '一次会话跑几轮「进副本 → 刷取 → 回城」。', minimum: 1, maximum: 50,
      },
      'worlds.wvd.stopOnDeath': {
        type: 'boolean', title: '死亡即停止',
        description: '主角死亡或队员倒下（复活 QTE）时结束会话，而不是等待回答；用于无人值守的连续跑图。',
      },
      'worlds.wvd.innRoom': {
        type: 'string', title: '旅店房间',
        description: '在旅店休息时选择的房间；旅店没有这个房间时用默认的标准房。',
      },
      'worlds.wvd.healAfterBattles': {
        type: 'integer', title: '战后恢复频率',
        description: '每完成几场战斗恢复一次：0 表示不恢复，1 表示每场，N 表示每 N 场。',
        minimum: 0, maximum: 50,
      },
      'worlds.wvd.healAfterChests': {
        type: 'integer', title: '开箱后恢复频率',
        description: '每完成几个宝箱恢复一次：0 表示不恢复，1 表示每个，N 表示每 N 个。',
        minimum: 0, maximum: 50,
      },
      'worlds.wvd.healOnEntry': {
        type: 'boolean', title: '进入副本时恢复',
        description: '每轮刚进入农场楼层、画面稳定后先恢复一次。',
      },
      'worlds.wvd.healAfterRest': {
        type: 'boolean', title: '休息后恢复',
        description: '在旅店休息后的首次进入副本时恢复一次。',
      },
      'worlds.wvd.taskFile': {
        type: 'string', title: '任务文件',
        description: '描述副本入口与离开路径的 JSON 文件；留空则使用内置路线。',
      },
      'worlds.wvd.stallStopSeconds': {
        type: 'integer', title: '停滞上限', description: '这么久没有进展就结束会话，秒。',
      },
      'worlds.wvd.gameWindowTitle': {
        type: 'string', title: '游戏窗口标题', description: '要捕获和操作的窗口。',
      },
      'worlds.wvd.jpegQuality': {
        // The loop encodes nothing since the vision module (2026-11-07): this is the World-side
        // escalation snapshot's quality, the only JPEG the machine still makes.
        type: 'integer', title: 'JPEG 质量', description: '升级快照的 JPEG 质量。', minimum: 30, maximum: 95,
      },
      'worlds.wvd.engineTimeoutMs': {
        type: 'integer', title: '引擎超时', description: '子进程一次请求的等待上限，毫秒。',
      },
      'worlds.wvd.pressHoldMs': {
        type: 'integer', title: '按键时长', description: '每次按下保持的时间；30 fps 下 0 毫秒的按键会被丢弃。', minimum: 40, maximum: 500,
      },
      'worlds.wvd.escalationImageWidth': {
        type: 'integer', title: '升级图像宽度', description: '发给模型前把帧缩到的宽度，像素。',
        minimum: MIN_CAPTURE_WIDTH, maximum: MAX_CAPTURE_WIDTH,
      },
      'worlds.wvd.mapOpenTimeoutMs': {
        type: 'integer', title: '地图打开超时', description: '点击小地图后等待地图出现，毫秒。',
      },
      'worlds.wvd.openerPanelTimeoutMs': {
        type: 'integer', title: '开箱面板超时', description: '点击「打开」后等待「由谁打开?」面板，毫秒；实测 5–8 秒。',
      },
      'worlds.wvd.automoveArrivalTimeoutMs': {
        type: 'integer', title: '自动移动超时', description: '一直没到达就放弃，毫秒。',
      },
      'worlds.wvd.automoveStillSeconds': {
        type: 'integer', title: '静止判定', description: '画面静止这么久即视为停下，秒。',
      },
      'worlds.wvd.hazardEscapeSteps': {
        type: 'integer', title: '脱困步数', description: '用 WASD 脱出受阻的步数。',
      },
      'worlds.wvd.hazardEscapeHoldMs': {
        type: 'integer', title: '脱困按键时长', description: '每一步保持的时间，毫秒。',
      },
      'worlds.wvd.resumeMaxAttempts': {
        type: 'integer', title: '恢复尝试次数', description: '自动移动被打断后点击恢复的次数。',
      },
      'worlds.wvd.willpowerFloor': {
        type: 'integer', title: '意志下限', description: '低于这个值的开箱者不选。',
      },
      'worlds.wvd.maxRerolls': {
        type: 'integer', title: '重选上限', description: '每个宝箱的 QTE 重选次数，仅限地板上的宝箱。',
      },
      'worlds.wvd.rerollLeadRatio': {
        type: 'number', title: '重选提前量比例', description: '提前量超过区间宽度的这个比例时重选。', minimum: 0, maximum: 1,
      },
      'worlds.wvd.qteLatencyMs': {
        type: 'integer', title: 'QTE 输入延迟', description: '实测的输入延迟，毫秒。', minimum: 1,
      },
      'worlds.wvd.qtePriorCarryTauS': {
        type: 'number', title: 'QTE 滑行先验',
        description: '每根新杆第一次按压的滑行时间先验，秒；测过停位后改用该杆自己的滑行。默认 0.05 秒（2026-11-06 停位数据的中位数）。',
        minimum: 0,
      },

      'worlds.wvd.qteAttemptsFallback': {
        type: 'integer', title: 'QTE 次数兜底', description: '读不出计数时使用。',
      },
      'worlds.wvd.qteSubLoopMs': {
        type: 'integer', title: 'QTE 计时预算',
        description: '开箱 QTE 的计时子循环最多占用多久，毫秒；最小 1，更小的预算连一次采样都放不下，超过即放弃这一拍。',
        minimum: 1,
      },
      'worlds.wvd.lootTapIntervalMs': {
        type: 'integer', title: '拾取间隔', description: '连续点击拾取的间隔，毫秒；实际间隔不小于操作节奏的 700 毫秒。',
      },
      'worlds.wvd.lootTapMax': {
        type: 'integer', title: '拾取上限', description: '放弃前最多点击几次。',
      },
      'worlds.wvd.autoBattleEnableAttempts': {
        type: 'integer', title: '自动战斗尝试次数', description: '尝试打开自动战斗的次数。',
      },
      'worlds.wvd.battleStepMs': {
        type: 'integer', title: '战斗操作节奏',
        description: '连续两次战斗操作的间隔，毫秒；从上次点击返回算起，不小于操作节奏的 700 毫秒。',
        minimum: 700, maximum: 5000,
      },
      'worlds.wvd.battleSettleMs': {
        type: 'integer', title: '战斗稳定等待', description: '战斗出现后先等这么久再按第一个键，毫秒。',
        minimum: 0, maximum: 10000,
      },
      'worlds.wvd.battleOpenerTimeoutMs': {
        type: 'integer', title: '技能起手超时',
        description: '连续两帧读到同一行动者才算确认；超过这个时长仍未确认就放弃这次技能，毫秒。',
        minimum: 1000, maximum: 60000,
      },
      'worlds.wvd.fightTimeoutMs': {
        type: 'integer', title: '战斗超时', description: '超过这个时长视为停滞，毫秒。',
      },
      'worlds.wvd.escalateMaxPerHour': {
        type: 'integer', title: '升级上限', description: '每小时模型调用次数，超过即结束会话。',
      },
      'worlds.wvd.escalateTimeoutMs': {
        type: 'integer', title: '升级等待上限', description: '等待回答的时间，毫秒。',
      },
      'worlds.wvd.escalateSettleMs': {
        type: 'integer', title: '无名画面等待',
        description: '画面无法命名时，先等这么久再决定是否提问，毫秒；0 表示第一帧就问。',
        minimum: 0,
      },
      'worlds.wvd.stopHotkey': {
        type: 'string', title: '停止快捷键', description: '由子进程注册的全局停止键。',
      },
    },
  },
};
