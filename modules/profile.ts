// 用户身份：决定记录页“常见”按钮有哪些，也告诉 AI 用户大致在做什么样的工作。

export interface CommonActivity {
  label: string;
  /** 只用来给按钮上色，不决定分类 */
  cat: string;
}

export interface Profile {
  role: string; // 预设 key 或 "custom"
  roleLabel: string;
  /** 一句话补充，例如“CS 方向博士三年级，主要做机器人学习” */
  description: string;
  activities: CommonActivity[];
}

const A = (label: string, cat: string): CommonActivity => ({ label, cat });

const LIFE = [
  A("运动", "cat_sport"),
  A("午休", "cat_rest"),
  A("吃饭", "cat_life"),
  A("通勤", "cat_life"),
  A("家务杂事", "cat_life"),
  A("和朋友聊天", "cat_fun"),
  A("看视频/玩游戏", "cat_fun"),
  A("刷手机", "cat_unknown"),
];

export const PROFILE_PRESETS: { key: string; label: string; work: CommonActivity[] }[] = [
  {
    key: "phd",
    label: "在读博士/研究生",
    work: [A("读论文", "cat_work"), A("写代码", "cat_work"), A("做实验", "cat_work"), A("写论文", "cat_work"), A("组会/讨论", "cat_work"), A("上课/助教", "cat_work")],
  },
  {
    key: "office",
    label: "上班族",
    work: [A("开会", "cat_work"), A("处理邮件/消息", "cat_work"), A("写文档", "cat_work"), A("做项目/方案", "cat_work"), A("和同事沟通", "cat_work"), A("学习充电", "cat_work")],
  },
  {
    key: "undergrad",
    label: "本科生",
    work: [A("上课", "cat_work"), A("写作业", "cat_work"), A("复习备考", "cat_work"), A("小组项目", "cat_work"), A("社团活动", "cat_fun"), A("自学", "cat_work")],
  },
  {
    key: "creator",
    label: "自由职业/创作者",
    work: [A("创作", "cat_work"), A("剪辑/后期", "cat_work"), A("接单沟通", "cat_work"), A("运营发布", "cat_work"), A("学习新技能", "cat_work"), A("找灵感", "cat_work")],
  },
];

export function presetActivities(key: string): CommonActivity[] {
  const p = PROFILE_PRESETS.find((x) => x.key === key) ?? PROFILE_PRESETS[0];
  return [...p.work, ...LIFE];
}

export const DEFAULT_PROFILE: Profile = {
  role: "phd",
  roleLabel: "在读博士/研究生",
  description: "",
  activities: presetActivities("phd"),
};

/** 给 AI 的一行身份说明 */
export function profileLine(p: Profile): string {
  return `用户身份：${p.roleLabel}${p.description ? `（${p.description}）` : ""}。按这个身份理解“工作”指什么，不要套用其他职业的习惯。`;
}
