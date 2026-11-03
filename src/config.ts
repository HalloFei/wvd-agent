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
  /** When true, the planner adds the measured brake carry; default false (freeze at registration). */
  qteBrakeEnabled: boolean;
  qteDecelPxPerS2: number;
  qteMinWindowMs: number;
  qteAttemptsFallback: number;
  /** How long the QTE timing sub-loop may hold the tick before it gives up, milliseconds. */
  qteSubLoopMs: number;
  lootTapIntervalMs: number;
  lootTapMax: number;
  autoBattleEnableAttempts: number;
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
  qteLatencyMs: 75,
  qteBrakeEnabled: false,
  qteDecelPxPerS2: 3000,
  qteMinWindowMs: 150,
  qteAttemptsFallback: 2,
  qteSubLoopMs: 4000,
  lootTapIntervalMs: 400,
  lootTapMax: 10,
  autoBattleEnableAttempts: 3,
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
        type: 'integer', title: 'JPEG 质量', description: '帧编码质量。', minimum: 30, maximum: 95,
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
      'worlds.wvd.qteBrakeEnabled': {
        type: 'boolean', title: 'QTE 刹车模型',
        description: '启用后按滑行刹车提前量计划；默认关闭（2026-10-31 实测按压在登记点冻结）。',
      },
      'worlds.wvd.qteDecelPxPerS2': {
        type: 'integer', title: 'QTE 减速度', description: '拟合的滑行常数，像素/秒²；暂定值。', minimum: 1,
      },
      'worlds.wvd.qteMinWindowMs': {
        type: 'integer', title: 'QTE 最小窗口',
        description: '比这更窄的过法直接放弃，毫秒；零表示不设下限。', minimum: 0,
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
