/**
 * The pages probed so far, as measured on 2026-11-06 (operator's live session, 1920x1080 client).
 *
 * Every row is a point that was pressed and answered: the enter rows are the taps that opened the
 * page they name, and the exit rows are the taps that were seen to leave it. A row that only needs a
 * name to be useful - a toggle, a claim, a purchase - is recorded as 'other' and was not pressed.
 *
 * Two frames per page are committed under testdata/screens/2026-11-06-ui/, the 1280 still the
 * recogniser was read from and, where the probe took one, the full-resolution capture the points were
 * measured on.
 */
import type { UiCatalog } from './catalog.ts';

export const UI_CATALOG: UiCatalog = {
  pages: [
    {
      id: 'dungeon',
      title: '3-D view (the dungeon itself)',
      section: 'dungeon',
      measured: '2026-11-06: the HUD icon row read off a live frame; 选项, 记录, 每日任务 and 道具 opened from it, and each was closed back onto this page',
      note: 'The row carries four more icons that were not pressed; the party card opens the character page. 搜索 is a world action, not a page.',
      rows: [
        { label: '搜索', kind: 'other', at: { x: 692, y: 797 } },
        { label: '每日任务', kind: 'enter', at: { x: 984, y: 797 }, child: 'missions' },
        { label: '选项', kind: 'enter', at: { x: 1_030, y: 797 }, child: 'options' },
        { label: '记录', kind: 'enter', at: { x: 1_076, y: 797 }, child: 'records' },
        { label: '道具', kind: 'enter', at: { x: 1_227, y: 797 }, child: 'inventory' },
        { label: '队伍成员卡', kind: 'enter', at: { x: 1_177, y: 1_012 }, child: 'character-page' },
      ],
    },
    {
      id: 'options',
      title: '选项 (settings)',
      section: 'dungeon',
      measured: '2026-11-06: opened from the HUD gear (1 030, 797); X 关闭 (960, 945) returned to the 3-D view',
      note: 'The twelve buttons were located, not pressed. 退出游戏, 充值限制确认, 数据绑定 and 设置居住国 are other: the probe records them and never presses them.',
      rows: [
        { label: '公告', kind: 'enter', at: { x: 840, y: 207 } },
        { label: '数据绑定', kind: 'other', at: { x: 1_031, y: 207 } },
        { label: '帮助', kind: 'enter', at: { x: 840, y: 274 } },
        { label: '选择语言', kind: 'enter', at: { x: 1_031, y: 274 } },
        { label: '设置居住国', kind: 'other', at: { x: 840, y: 342 } },
        { label: '充值限制确认', kind: 'other', at: { x: 1_031, y: 342 } },
        { label: '装备自动锁定', kind: 'enter', at: { x: 840, y: 410 } },
        { label: '冒险者自动锁定', kind: 'enter', at: { x: 1_031, y: 410 } },
        { label: '自动移动设置', kind: 'enter', at: { x: 840, y: 477 } },
        { label: '宝箱道具整理', kind: 'enter', at: { x: 1_031, y: 477 } },
        { label: '按键设置', kind: 'enter', at: { x: 840, y: 545 } },
        { label: '退出游戏', kind: 'other', at: { x: 1_031, y: 545 } },
        { label: '关闭', kind: 'exit', at: { x: 960, y: 945 }, child: 'dungeon' },
      ],
    },
    {
      id: 'records',
      title: '记录 (records menu)',
      section: 'dungeon',
      measured: '2026-11-06: opened from the HUD clipboard (1 076, 797); X 关闭 (960, 870) returned to the 3-D view. Its rows were located, not pressed.',
      note: 'This is the page that stopped the 99-cycle run (task t-mw4z5ffs-2o0jnp): it is a full-screen menu no recogniser named.',
      rows: [
        { label: '委托一览', kind: 'enter', at: { x: 960, y: 285 } },
        { label: '悬赏令列表', kind: 'enter', at: { x: 960, y: 356 } },
        { label: '道具一览', kind: 'enter', at: { x: 960, y: 426 } },
        { label: '宝石持有数', kind: 'enter', at: { x: 960, y: 497 } },
        { label: '图鉴', kind: 'enter', at: { x: 960, y: 567 } },
        { label: '成就', kind: 'enter', at: { x: 960, y: 638 } },
        { label: '知识', kind: 'enter', at: { x: 960, y: 708 } },
        { label: '通行证', kind: 'enter', at: { x: 960, y: 779 } },
        { label: '关闭', kind: 'exit', at: { x: 960, y: 870 }, child: 'dungeon' },
      ],
    },
    {
      id: 'missions',
      title: '每日任务 (daily missions)',
      section: 'dungeon',
      measured: '2026-11-06: opened from the HUD checklist (984, 797); 返回 (754, 1 029) returned to the 3-D view',
      note: '领取 claims a reward and 移动 jumps to the mission; both are other. The 每日 / 每周 / 逢魔夜祭 and 期间限定 / 无期限 tabs were located only.',
      rows: [
        { label: '领取', kind: 'other', at: { x: 1_152, y: 447 } },
        { label: '移动', kind: 'other', at: { x: 1_152, y: 592 } },
        { label: '移动', kind: 'other', at: { x: 1_152, y: 742 } },
        { label: '每日', kind: 'enter', at: { x: 742, y: 892 } },
        { label: '每周', kind: 'enter', at: { x: 870, y: 892 } },
        { label: '逢魔夜祭', kind: 'enter', at: { x: 1_008, y: 892 } },
        { label: '期间限定', kind: 'enter', at: { x: 742, y: 952 } },
        { label: '无期限', kind: 'enter', at: { x: 1_008, y: 952 } },
        { label: '返回', kind: 'exit', at: { x: 754, y: 1_029 }, child: 'dungeon' },
      ],
    },
    {
      id: 'inventory',
      title: '道具一览 (item list)',
      section: 'dungeon',
      measured: '2026-11-06: opened from the HUD bag (1 227, 797); X 关闭 (960, 989) returned to the 3-D view',
      note: 'The category strip and the member filters were located only; they filter the same page, so no edge is claimed.',
      rows: [
        { label: '关闭', kind: 'exit', at: { x: 960, y: 989 }, child: 'dungeon' },
      ],
    },
    {
      id: 'character-page',
      title: '角色页 (character page)',
      section: 'dungeon',
      measured: '2026-11-06: opened by the party card (1 177, 1 012); X 关闭 (699, 1 012) returned to the 3-D view (the quick-heal path measured it on 2026-11-03)',
      note: 'The five tabs (强度 / 技能 / 咒文 / 装备 / 背包) were located only; the heal taps the page panel, not a tab.',
      rows: [
        { label: '强度', kind: 'enter', at: { x: 599, y: 1_014 } },
        { label: '技能', kind: 'enter', at: { x: 746, y: 1_014 } },
        { label: '咒文', kind: 'enter', at: { x: 893, y: 1_014 } },
        { label: '装备', kind: 'enter', at: { x: 1_040, y: 1_014 } },
        { label: '背包', kind: 'enter', at: { x: 1_185, y: 1_014 } },
        { label: '关闭', kind: 'exit', at: { x: 699, y: 1_012 }, child: 'dungeon' },
      ],
    },
    {
      id: 'town',
      title: '诺森霍洛村 (the rest town, vnh)',
      section: 'town',
      measured: '2026-11-06: reached by the measured exit route (dungeon map, F, Dungeon Select, travel vnh); 寺院, 旅店, 交易商 and 道具店 opened from it',
      note: 'The two other facilities (打铁铺, 酒馆) were located but not opened: the point beside 打铁铺 opened 祝福之日 twice, so the event notice may be what the forge shows first. The 旅店 point is the operator measured one the cycle already uses.',
      rows: [
        { label: '寺院', kind: 'enter', at: { x: 804, y: 402 }, child: 'temple' },
        { label: '旅店', kind: 'enter', at: { x: 916, y: 488 }, child: 'inn-service' },
        { label: '交易商', kind: 'enter', at: { x: 1_029, y: 530 }, child: 'trader' },
        { label: '道具店', kind: 'enter', at: { x: 1_185, y: 572 }, child: 'shop' },
        { label: '祝福之日（打铁铺）', kind: 'enter', at: { x: 1_133, y: 402 }, child: 'blessed-day' },
        { label: '祝福之日（城镇图标）', kind: 'enter', at: { x: 1_092, y: 1_023 }, child: 'blessed-day' },
      ],
    },
    {
      id: 'shop',
      title: '道具店 (item shop)',
      section: 'town',
      measured: '2026-11-06: opened from the town icon (1 185, 572); 离开 (1 162, 677) returned to the town',
      rows: [
        { label: '购买', kind: 'other', at: { x: 1_162, y: 447 } },
        { label: '出售', kind: 'other', at: { x: 1_162, y: 519 } },
        { label: '对话', kind: 'enter', at: { x: 1_162, y: 608 } },
        { label: '离开', kind: 'exit', at: { x: 1_162, y: 677 }, child: 'town' },
      ],
    },
    {
      id: 'temple',
      title: '寺院 (temple)',
      section: 'town',
      measured: '2026-11-06: opened from the town icon (804, 402); 离开 (1 162, 677) returned to the town',
      note: '复活 and 治疗 spend gold: other. The quick-heal the World uses is the HUD one, not this.',
      rows: [
        { label: '复活', kind: 'other', at: { x: 1_162, y: 448 } },
        { label: '治疗', kind: 'other', at: { x: 1_162, y: 519 } },
        { label: '对话', kind: 'enter', at: { x: 1_162, y: 608 } },
        { label: '离开', kind: 'exit', at: { x: 1_162, y: 677 }, child: 'town' },
      ],
    },
    {
      id: 'trader',
      title: '交易商 (trade)',
      section: 'town',
      measured: '2026-11-06: opened from the town icon (1 029, 530); 兑换所 (1 162, 585) opened 祝福之日, 离开 (1 162, 675) returned to the town (0.944)',
      note: 'The two rows sit where a four-row dialog draws its last pair, not at the shop row ys: a tap at 1 162,723 does nothing, which is how this point was found.',
      rows: [
        { label: '兑换所', kind: 'enter', at: { x: 1_162, y: 585 }, child: 'blessed-day' },
        { label: '离开', kind: 'exit', at: { x: 1_162, y: 675 }, child: 'town' },
      ],
    },
    {
      id: 'blessed-day',
      title: '祝福之日 (event notice)',
      section: 'town',
      measured: '2026-11-06: opened over the trader from 兑换所; X 关闭 (960, 866) closed it back onto the trader',
      note: 'Measured both over the town (2026-11-06 live: the town icon at 1 092,1 023 and the point beside 打铁铺 at 1 133,402, the 1920 live frame named at 0.921) and over the trader (兑换所). 关闭 returns to whatever it covered. 移动 leaves for a shop: other.',
      rows: [
        { label: '移动', kind: 'other', at: { x: 1_134, y: 474 } },
        { label: '移动', kind: 'other', at: { x: 1_134, y: 716 } },
        { label: '关闭', kind: 'exit', at: { x: 960, y: 866 }, child: 'town' },
      ],
    },
    {
      id: 'inn-service',
      title: '旅店 (innkeeper service menu)',
      section: 'town',
      measured: '2026-11-06, the inn library frames: 住宿 (1 114, 488), 对话 (1 114, 578), 离开 (1 114, 641)',
      rows: [
        { label: '住宿', kind: 'enter', at: { x: 1_114, y: 488 }, child: 'inn-rooms' },
        { label: '对话', kind: 'enter', at: { x: 1_114, y: 578 } },
        { label: '离开', kind: 'exit', at: { x: 1_114, y: 641 }, child: 'town' },
      ],
    },
    {
      id: 'inn-rooms',
      title: '旅店房间 (room list)',
      section: 'town',
      measured: '2026-11-06, the inn library frames: 马房 (1 114, 549), 标准房 (1 114, 606), 返回 (1 114, 660)',
      rows: [
        { label: '马房', kind: 'enter', at: { x: 1_114, y: 549 } },
        { label: '标准房', kind: 'enter', at: { x: 1_114, y: 606 }, child: 'inn-confirm' },
        { label: '返回', kind: 'exit', at: { x: 1_114, y: 660 }, child: 'inn-service' },
      ],
    },
    {
      id: 'inn-confirm',
      title: '旅店确认 (rest confirmation)',
      section: 'town',
      measured: '2026-11-06, the inn library frames: 取消 (854, 675), 确定 (1 062, 675)',
      note: '确定 spends gold and starts the rest: other. The cycle confirms a rest it already meant to take through the policy, not through this graph.',
      rows: [
        { label: '取消', kind: 'exit', at: { x: 854, y: 675 }, child: 'inn-rooms' },
        { label: '确定', kind: 'other', at: { x: 1_062, y: 675 } },
      ],
    },
  ],
};

/** Every id the catalog can answer for; a task file may only name these. */
export const UI_PAGE_IDS: ReadonlySet<string> = new Set(UI_CATALOG.pages.map((page) => page.id));
