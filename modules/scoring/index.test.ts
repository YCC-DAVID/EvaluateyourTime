import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_CATEGORIES,
  backfillWindowStart,
  buildHeatmap,
  checkAllocations,
  checkRecordWindow,
  computeDayStats,
  computeOverall,
  durationMinutes,
  resolveOverlaps,
  sanitizeAllocations,
  type DayEntry,
} from "./index.ts";

const ids = new Set(BUILTIN_CATEGORIES.map((c) => c.id));

test("跨午夜时长", () => {
  assert.equal(durationMinutes("2026-11-24T15:30:00Z", "2026-11-24T17:00:00Z"), 90);
  assert.equal(durationMinutes("2026-11-24T23:30:00Z", "2026-11-25T01:00:00Z"), 90);
  assert.equal(durationMinutes("2026-11-24T10:00:00Z", "2026-11-24T09:00:00Z"), 0);
});

test("分配总和超限会报错", () => {
  const r = checkAllocations(
    [{ category_id: "cat_work", minutes: 120, state: "confirmed" }, { category_id: "cat_waste", minutes: 70, state: "confirmed" }],
    180,
  );
  assert.equal(r.ok, false);
});

test("AI 分配清洗：去无效分类、合并、按比例缩小、标为估计", () => {
  const r = sanitizeAllocations(
    [
      { category_id: "cat_work", minutes: 150 },
      { category_id: "cat_work", minutes: 30 },
      { category_id: "bogus", minutes: 60 },
      { category_id: "cat_waste", minutes: 60 },
    ],
    180,
    ids,
  );
  const total = r.reduce((s, a) => s + a.minutes, 0);
  assert.ok(total <= 180);
  assert.equal(r.length, 2);
  assert.ok(r.every((a) => a.state === "estimated"));
});

test("休息不套用目标贡献", () => {
  const dims = { execution_quality: 90, goal_contribution: 0, arrangement_quality: 90 };
  assert.equal(computeOverall(dims, "rest"), 90);
});

const day0 = Date.parse("2026-11-24T00:00:00Z");
const day1 = Date.parse("2026-11-25T00:00:00Z");

test("有效工作只计确认分配；无工作时重点占比为 null", () => {
  const e: DayEntry = {
    id: "e1", start: "2026-11-24T14:00:00Z", end: "2026-11-24T17:00:00Z", overall: 80, confirmed: true, goal_id: "g1",
    allocations: [
      { category_id: "cat_work", minutes: 120, state: "confirmed" },
      { category_id: "cat_rest", minutes: 30, state: "confirmed" },
      { category_id: "cat_waste", minutes: 30, state: "confirmed" },
    ],
  };
  const s = computeDayStats([e], BUILTIN_CATEGORIES, day0, day1, day1, 360, "g1");
  assert.equal(s.effectiveWorkMinutes, 120);
  assert.equal(s.primaryGoalShare, 1);
  const est = { ...e, allocations: e.allocations.map((a) => ({ ...a, state: "estimated" as const })) };
  const s2 = computeDayStats([est], BUILTIN_CATEGORIES, day0, day1, day1, 360, "g1");
  assert.equal(s2.effectiveWorkMinutes, 0);
  assert.equal(s2.primaryGoalShare, null);
});

test("跨天记录按比例分摊并标记", () => {
  const e: DayEntry = {
    id: "e2", start: "2026-11-24T23:00:00Z", end: "2026-11-25T01:00:00Z", overall: 70, confirmed: true, goal_id: null,
    allocations: [{ category_id: "cat_work", minutes: 120, state: "confirmed" }],
  };
  const s = computeDayStats([e], BUILTIN_CATEGORIES, day0, day1, day1, 360, null);
  assert.equal(s.effectiveWorkMinutes, 60);
  assert.equal(s.prorated, true);
});

test("补录窗口：今天、昨天、前天可以，更早和未来不行", () => {
  const now = new Date(2026, 10, 24, 10, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).getTime();
  assert.equal(checkRecordWindow(at(22, 0), at(22, 1), now), null); // 前天 0 点
  assert.match(checkRecordWindow(at(21, 23), at(22, 1), now)!, /最近 3 天/);
  assert.match(checkRecordWindow(at(24, 9), at(24, 11), now)!, /未来/);
  assert.equal(checkRecordWindow(at(24, 9), now + 60000, now), null); // 容忍 1 分钟时钟偏差
  assert.equal(backfillWindowStart(now), at(22, 0));
});

test("热力图：96 格，覆盖格用整段平均分，未记录为 null", () => {
  const e: DayEntry = {
    id: "e1", start: "2026-11-24T14:00:00Z", end: "2026-11-24T14:20:00Z", overall: 60, confirmed: true, goal_id: null, allocations: [],
  };
  const cells = buildHeatmap([e], day0, day1);
  assert.equal(cells.length, 96);
  assert.equal(cells[56].score, 60);
  assert.equal(cells[56].coveredMinutes, 15);
  assert.equal(cells[57].coveredMinutes, 5);
  assert.equal(cells[58].score, null);
});

test("时间重叠：后建的记录优先，统计不重复计数", () => {
  const cats = [
    { id: "w", name: "工作", kind: "work", color: "#000", builtin: true },
    { id: "r", name: "休息", kind: "rest", color: "#000", builtin: true },
  ] as any;
  const d0 = Date.parse("2026-11-25T05:00:00Z");
  const d1 = d0 + 24 * 3600_000;
  const old = {
    id: "old", start: "2026-11-25T05:37:00Z", end: "2026-11-25T12:38:00Z", overall: 60, confirmed: true, goal_id: null,
    allocations: [{ category_id: "r", minutes: 392, state: "confirmed" }, { category_id: "w", minutes: 27, state: "confirmed" }],
    createdAt: "2026-11-25T12:38:00Z",
  } as any;
  const sleep = {
    id: "sleep", start: "2026-11-25T07:00:00Z", end: "2026-11-25T12:30:00Z", overall: 90, confirmed: true, goal_id: null,
    allocations: [{ category_id: "r", minutes: 330, state: "confirmed" }],
    createdAt: "2026-11-25T17:17:00Z",
  } as any;
  const st = computeDayStats([old, sleep], cats, d0, d1, d1, 360, null);
  // 墙钟时间：05:37–12:38 = 421 分钟，不是 421 + 330
  assert.equal(st.recordedMinutes, 421);
  assert.ok(st.minutesByKind.rest + st.minutesByKind.work <= 421);
  // 睡眠覆盖的部分从原记录的“休息”里扣，原记录的 27 分钟工作保留
  assert.equal(st.minutesByKind.work, 27);
  assert.equal(st.minutesByKind.rest, 392);
  const r = resolveOverlaps([old, sleep]);
  assert.equal(r[0].overlappedMinutes, 330);
  assert.equal(r[1].overlappedMinutes, 0);
  // 被睡眠覆盖的格子按睡眠的分数着色
  const cells = buildHeatmap([old, sleep], d0, d1);
  const at = cells.find((c) => c.start === Date.parse("2026-11-25T09:00:00Z"))!;
  assert.equal(at.score, 90);
  assert.deepEqual(at.entryIds, ["sleep"]);
});
