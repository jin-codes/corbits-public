// Corbits in the macOS menu bar: shows what is running and what needs your approval, and opens the
// dashboard already signed in (through a one-time code, never a token in a URL).
//
// Reads the API token from the project's .env (path given as the first argument). The token stays in
// memory; nothing is written anywhere. Build and install with scripts/menubar.sh.
import AppKit
import Foundation

// MARK: configuration

struct Config {
    let baseURL: URL
    let token: String
    let korean: Bool
}

func loadConfig(envFile: String) -> Config? {
    guard let text = try? String(contentsOfFile: envFile, encoding: .utf8) else { return nil }
    var values: [String: String] = [:]
    for raw in text.split(whereSeparator: \.isNewline) {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("#") { continue }
        guard let eq = line.firstIndex(of: "=") else { continue }
        let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
        var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
        if value.count >= 2, (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
            value = String(value.dropFirst().dropLast())
        }
        values[key] = value
    }
    // First "owner:token" entry; the token is everything after the first colon.
    guard let first = values["CORBITS_API_TOKENS"]?.split(separator: ",").first,
          let colon = first.firstIndex(of: ":") else { return nil }
    let token = String(first[first.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
    if token.isEmpty { return nil }
    let port = values["PORT"] ?? "8787"
    let base = ProcessInfo.processInfo.environment["CORBITS_MENUBAR_URL"] ?? "http://127.0.0.1:\(port)"
    guard let url = URL(string: base) else { return nil }
    return Config(baseURL: url, token: token, korean: (values["CORBITS_LOCALE"] ?? "ko") != "en")
}

// MARK: model

struct TaskInfo { let id: String; let goal: String; let status: String; let helpReason: String? }
struct ApprovalInfo { let id: String; let taskId: String; let summary: String }

final class Client {
    let config: Config
    init(config: Config) { self.config = config }

    private func request(_ path: String, method: String = "GET") async throws -> Any {
        // Plain concatenation: appendingPathComponent would percent-encode the "?" of a query string.
        let base = config.baseURL.absoluteString.hasSuffix("/") ? String(config.baseURL.absoluteString.dropLast()) : config.baseURL.absoluteString
        guard let url = URL(string: base + "/" + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 4
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return try JSONSerialization.jsonObject(with: data)
    }

    func tasks() async throws -> [TaskInfo] {
        guard let root = try await request("tasks?limit=30") as? [String: Any], let list = root["tasks"] as? [[String: Any]] else { return [] }
        return list.compactMap { t in
            guard let id = t["id"] as? String, let status = t["status"] as? String else { return nil }
            let help = (t["helpRequest"] as? [String: Any])?["reason"] as? String
            return TaskInfo(id: id, goal: (t["goal"] as? String) ?? "", status: status, helpReason: help)
        }
    }

    func approvals() async throws -> [ApprovalInfo] {
        guard let root = try await request("approvals") as? [String: Any], let list = root["approvals"] as? [[String: Any]] else { return [] }
        return list.compactMap { a in
            guard let id = a["id"] as? String, let taskId = a["taskId"] as? String else { return nil }
            return ApprovalInfo(id: id, taskId: taskId, summary: (a["summary"] as? String) ?? "")
        }
    }

    /// A one-time sign-in code for the dashboard, or nil if the server does not support it.
    func loginCode() async -> String? {
        guard let obj = try? await request("auth/code", method: "POST") as? [String: Any] else { return nil }
        return obj["code"] as? String
    }
}

let activeStatuses: Set<String> = ["queued", "planning", "running", "awaiting_approval", "human_control", "verifying"]

// MARK: app

final class MenuBarApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let client: Client
    let ko: Bool
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var tasks: [TaskInfo] = []
    var approvals: [ApprovalInfo] = []
    var reachable = true
    var knownHelp: Set<String>? = nil // tasks already announced as needing help
    var knownApprovals: Set<String>? = nil // nil until the first successful poll, so a restart does not re-announce old ones

    init(client: Client) {
        self.client = client
        self.ko = client.config.korean
        super.init()
    }

    func L(_ korean: String, _ english: String) -> String { ko ? korean : english }

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.delegate = self
        item.menu = menu
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "bolt.circle", accessibilityDescription: "Corbits")
            button.imagePosition = .imageLeading
            button.title = ""
        }
        rebuildMenu()
        poll()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
    }

    func poll() {
        Task {
            do {
                async let t = client.tasks()
                async let a = client.approvals()
                let (newTasks, newApprovals) = try await (t, a)
                await MainActor.run { self.apply(tasks: newTasks, approvals: newApprovals) }
            } catch {
                await MainActor.run {
                    self.reachable = false
                    self.refreshTitle()
                    self.rebuildMenu()
                    if printMode { self.dumpAndExit(1) }
                }
            }
        }
    }

    func apply(tasks newTasks: [TaskInfo], approvals newApprovals: [ApprovalInfo]) {
        reachable = true
        tasks = newTasks
        approvals = newApprovals
        let ids = Set(newApprovals.map { $0.id })
        if let known = knownApprovals {
            for a in newApprovals where !known.contains(a.id) { notify(L("승인이 필요합니다", "Approval needed"), a.summary) }
        }
        knownApprovals = ids
        let helpIds = Set(newTasks.filter { $0.helpReason != nil }.map { $0.id })
        if let known = knownHelp {
            for t in newTasks where t.helpReason != nil && !known.contains(t.id) {
                notify(L("도움이 필요합니다", "Needs your help"), clip(t.goal, 40) + " — " + (t.helpReason ?? ""))
            }
        }
        knownHelp = helpIds
        refreshTitle()
        rebuildMenu()
        if printMode { dumpAndExit(0) }
    }

    func dumpAndExit(_ code: Int32) {
        print("title:\(item.button?.title ?? "")")
        for m in menu.items { print(m.isSeparatorItem ? "---" : "item:\(m.title)") }
        exit(code)
    }

    func refreshTitle() {
        let running = tasks.filter { activeStatuses.contains($0.status) }.count
        let helpCount = tasks.filter { $0.helpReason != nil }.count
        var title = ""
        if !reachable { title = " ×" }
        else if !approvals.isEmpty || helpCount > 0 {
            title = ""
            if !approvals.isEmpty { title += " ⚠︎\(approvals.count)" }
            if helpCount > 0 { title += " ✋\(helpCount)" }
        }
        else if running > 0 { title = " \(running)" }
        item.button?.title = title
    }

    func statusLabel(_ s: String) -> String {
        switch s {
        case "queued": return L("대기", "Queued")
        case "planning": return L("계획 중", "Planning")
        case "running": return L("실행 중", "Running")
        case "awaiting_approval": return L("승인 필요", "Needs approval")
        case "human_control": return L("직접 조작 중", "You are in control")
        case "verifying": return L("확인 중", "Verifying")
        default: return s
        }
    }

    func clip(_ s: String, _ n: Int) -> String {
        let one = s.replacingOccurrences(of: "\n", with: " ")
        return one.count > n ? String(one.prefix(n - 1)) + "…" : one
    }

    func rebuildMenu() {
        menu.removeAllItems()
        let open = NSMenuItem(title: L("Corbits 열기", "Open Corbits"), action: #selector(openDashboard), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())

        if !reachable {
            let down = NSMenuItem(title: L("서버에 연결할 수 없습니다", "Cannot reach the server"), action: nil, keyEquivalent: "")
            down.isEnabled = false
            menu.addItem(down)
        } else {
            if !approvals.isEmpty {
                let head = NSMenuItem(title: L("승인 대기 \(approvals.count)건", "\(approvals.count) waiting for approval"), action: nil, keyEquivalent: "")
                head.isEnabled = false
                menu.addItem(head)
                for a in approvals {
                    let m = NSMenuItem(title: "⚠︎ " + clip(a.summary, 60), action: #selector(openTask(_:)), keyEquivalent: "")
                    m.target = self
                    m.representedObject = a.taskId
                    menu.addItem(m)
                }
                menu.addItem(.separator())
            }
            let active = tasks.filter { activeStatuses.contains($0.status) }
            let head = NSMenuItem(title: active.isEmpty ? L("진행 중인 작업 없음", "No tasks running") : L("진행 중 \(active.count)건", "\(active.count) in progress"), action: nil, keyEquivalent: "")
            head.isEnabled = false
            menu.addItem(head)
            for t in active {
                let label = t.helpReason != nil ? L("도움 필요", "Needs help") : statusLabel(t.status)
                let m = NSMenuItem(title: (t.helpReason != nil ? "✋ [" : "● [") + label + "] " + clip(t.goal, 50), action: #selector(openTask(_:)), keyEquivalent: "")
                m.target = self
                m.representedObject = t.id
                menu.addItem(m)
            }
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: L("종료", "Quit"), action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    func menuNeedsUpdate(_ menu: NSMenu) { poll() }

    @objc func openDashboard() { open(taskId: nil) }
    @objc func openTask(_ sender: NSMenuItem) { open(taskId: sender.representedObject as? String) }
    @objc func quit() { NSApplication.shared.terminate(nil) }

    func open(taskId: String?) {
        Task {
            var url = client.config.baseURL
            if let code = await client.loginCode() {
                var fragment = "#/login/\(code)"
                if let id = taskId { fragment += "?to=/tasks/\(id)" }
                url = URL(string: client.config.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + fragment) ?? url
            }
            let target = url
            await MainActor.run { _ = NSWorkspace.shared.open(target) }
        }
    }

    /// The text can come from a web page, so it is passed to AppleScript as an argument, never spliced into the script.
    func notify(_ title: String, _ body: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, clip(body, 120)]
        try? p.run()
    }
}

// MARK: main

/// `CorbitsMenuBar <env> --print` polls once, prints the title and menu it would show, and exits. For checking a setup.
let printMode = CommandLine.arguments.contains("--print")

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: CorbitsMenuBar <path to .env>\n".utf8))
    exit(2)
}
guard let config = loadConfig(envFile: args[1]) else {
    FileHandle.standardError.write(Data("Could not read an API token (CORBITS_API_TOKENS) from \(args[1])\n".utf8))
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = MenuBarApp(client: Client(config: config))
app.delegate = delegate
app.run()
