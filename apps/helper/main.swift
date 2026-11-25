// 时间记录助手：用 EventKit 读日历、读写提醒事项。
// 由本地服务通过 `open -W -g -n -a TimeAgentHelper.app --args <命令> <输入文件> <输出文件>` 启动，
// 结果写成 JSON 到输出文件。作为独立的小应用，macOS 的日历/提醒事项授权会挂在它名下。
import EventKit
import Foundation

let store = EKEventStore()
let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "status"
let inPath = args.count > 2 ? args[2] : ""
let outPath = args.count > 3 ? args[3] : ""
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func write(_ obj: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
  if outPath.isEmpty { FileHandle.standardOutput.write(data) } else { try? data.write(to: URL(fileURLWithPath: outPath)) }
}
func fail(_ msg: String) -> Never {
  write(["error": msg])
  exit(0)
}
func input() -> [String: Any] {
  guard !inPath.isEmpty, let d = try? Data(contentsOf: URL(fileURLWithPath: inPath)),
        let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
  return j
}
func statusName(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .fullAccess: return "granted"
  case .writeOnly: return "write-only"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-determined"
  @unknown default: return "unknown"
  }
}
func wait(_ block: (@escaping () -> Void) -> Void) {
  let sem = DispatchSemaphore(value: 0)
  block { sem.signal() }
  _ = sem.wait(timeout: .now() + 120)
}
/// 需要时请求授权（第一次会弹出系统窗口）
func ensure(_ type: EKEntityType) -> Bool {
  let s = EKEventStore.authorizationStatus(for: type)
  if s == .fullAccess { return true }
  if s != .notDetermined { return false }
  var ok = false
  wait { done in
    if type == .event {
      store.requestFullAccessToEvents { g, _ in ok = g; done() }
    } else {
      store.requestFullAccessToReminders { g, _ in ok = g; done() }
    }
  }
  return ok
}
func dateFrom(_ v: Any?) -> Date? {
  guard let s = v as? String, !s.isEmpty else { return nil }
  return iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}
func dayString(_ c: DateComponents?) -> Any {
  guard let c = c, let y = c.year, let m = c.month, let d = c.day else { return NSNull() }
  return String(format: "%04d-%02d-%02d", y, m, d)
}
func dueComponents(_ day: String) -> DateComponents? {
  let p = day.split(separator: "-").compactMap { Int($0) }
  guard p.count == 3 else { return nil }
  var c = DateComponents()
  c.year = p[0]; c.month = p[1]; c.day = p[2]
  return c
}
func reminderJSON(_ r: EKReminder) -> [String: Any] {
  [
    "id": r.calendarItemIdentifier,
    "listId": r.calendar.calendarIdentifier,
    "title": r.title ?? "",
    "completed": r.isCompleted,
    "due": dayString(r.dueDateComponents),
    "modified": r.lastModifiedDate.map { iso.string(from: $0) } ?? NSNull(),
  ]
}

switch cmd {
case "status":
  write(["calendar": statusName(EKEventStore.authorizationStatus(for: .event)),
         "reminders": statusName(EKEventStore.authorizationStatus(for: .reminder))])

case "request":
  let c = ensure(.event)
  let r = ensure(.reminder)
  write(["calendar": c ? "granted" : statusName(EKEventStore.authorizationStatus(for: .event)),
         "reminders": r ? "granted" : statusName(EKEventStore.authorizationStatus(for: .reminder))])

case "calendars":
  guard ensure(.event) else { fail("没有日历权限") }
  write(["calendars": store.calendars(for: .event).map {
    ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title]
  }])

case "events":
  guard ensure(.event) else { fail("没有日历权限") }
  let j = input()
  guard let start = dateFrom(j["start"]), let end = dateFrom(j["end"]) else { fail("时间范围无效") }
  let ids = Set((j["calendarIds"] as? [String]) ?? [])
  let cals = store.calendars(for: .event).filter { ids.isEmpty || ids.contains($0.calendarIdentifier) }
  if cals.isEmpty { write(["events": [[String: Any]]()]); exit(0) }
  // predicateForEvents 会展开重复日程，每次发生都是单独的一条
  let evs = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: cals))
  write(["events": evs.map { e -> [String: Any] in
    [
      "id": "\(e.eventIdentifier ?? e.calendarItemIdentifier)@\(iso.string(from: e.startDate))",
      "calendarId": e.calendar.calendarIdentifier,
      "title": e.title ?? "",
      "start": iso.string(from: e.startDate),
      "end": iso.string(from: e.endDate),
      "allDay": e.isAllDay,
    ]
  }])

case "reminder-lists":
  guard ensure(.reminder) else { fail("没有提醒事项权限") }
  write(["lists": store.calendars(for: .reminder).map {
    ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title]
  }])

case "reminders":
  // 输入：listIds、since（已完成的只取这之后完成的）、knownIds（已关联的，返回其中已被删除的）
  guard ensure(.reminder) else { fail("没有提醒事项权限") }
  let j = input()
  let ids = Set((j["listIds"] as? [String]) ?? [])
  let cals = store.calendars(for: .reminder).filter { ids.contains($0.calendarIdentifier) }
  var out: [[String: Any]] = []
  if !cals.isEmpty {
    var items: [EKReminder] = []
    wait { done in
      store.fetchReminders(matching: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals)) { rs in
        items += rs ?? []; done()
      }
    }
    let since = dateFrom(j["since"]) ?? Date(timeIntervalSinceNow: -30 * 86400)
    wait { done in
      store.fetchReminders(matching: store.predicateForCompletedReminders(withCompletionDateStarting: since, ending: nil, calendars: cals)) { rs in
        items += rs ?? []; done()
      }
    }
    out = items.map(reminderJSON)
  }
  let known = (j["knownIds"] as? [String]) ?? []
  let missing = known.filter { store.calendarItem(withIdentifier: $0) == nil }
  write(["reminders": out, "missing": missing])

case "apply-reminders":
  // 输入：ops = [{op:"create", listId, title, due?, completed?} | {op:"update", id, title?, due?, completed?}]
  guard ensure(.reminder) else { fail("没有提醒事项权限") }
  let ops = (input()["ops"] as? [[String: Any]]) ?? []
  var results: [[String: Any]] = []
  for op in ops {
    var r: EKReminder?
    if (op["op"] as? String) == "create" {
      guard let listId = op["listId"] as? String, let cal = store.calendar(withIdentifier: listId) else {
        results.append(["error": "找不到提醒事项列表"]); continue
      }
      r = EKReminder(eventStore: store)
      r!.calendar = cal
    } else if let id = op["id"] as? String {
      r = store.calendarItem(withIdentifier: id) as? EKReminder
    }
    guard let rem = r else { results.append(["error": "找不到这条提醒事项"]); continue }
    if let t = op["title"] as? String { rem.title = t }
    if op.keys.contains("due") {
      if let d = op["due"] as? String, let c = dueComponents(d) { rem.dueDateComponents = c } else { rem.dueDateComponents = nil }
    }
    if let c = op["completed"] as? Bool { rem.isCompleted = c }
    do {
      try store.save(rem, commit: false)
      results.append(reminderJSON(rem))
    } catch {
      results.append(["error": error.localizedDescription])
    }
  }
  do { try store.commit() } catch { fail("保存提醒事项失败：\(error.localizedDescription)") }
  write(["results": results])

default:
  fail("未知命令：\(cmd)")
}
