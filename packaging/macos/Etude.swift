// Etude.app: starts the bundled Etude server and shows it in a native window.
// Everything it needs is inside the bundle (Node + the app); data lives in ~/.etude.
import Cocoa
import WebKit

let bundle = Bundle.main.resourceURL!
let nodeBin = bundle.appendingPathComponent("node/bin/node")
let appDir = bundle.appendingPathComponent("app")
let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".etude")
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Etude.log")
let preferredPort = 4610

/// Is something already listening on this port?
func portInUse(_ port: Int) -> Bool {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(s) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    return r == 0
}

/// A free port picked by the OS.
func freePort() -> Int {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(s) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
    return Int(UInt16(bigEndian: addr.sin_port))
}

/// Does an Etude server answer on this port? (Then we reuse it: same database.)
func probeEtude(_ port: Int) -> Bool {
    guard let url = URL(string: "http://127.0.0.1:\(port)/api/themes") else { return false }
    var req = URLRequest(url: url); req.timeoutInterval = 1.5
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let d = data, (resp as? HTTPURLResponse)?.statusCode == 200, let s = String(data: d, encoding: .utf8), s.contains("\"themes\"") { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2)
    return ok
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var port = preferredPort
    var log: FileHandle?

    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func applicationDidFinishLaunching(_ n: Notification) {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Etude"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.04, green: 0.04, blue: 0.05, alpha: 1)
        window.contentView = web
        window.setFrameAutosaveName("EtudeMain")
        if !window.setFrameUsingName("EtudeMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        buildMenu()
        showMessage("Starting Etude…", detail: "")
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.global().async { self.start() }
    }

    func start() {
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        log = try? FileHandle(forWritingTo: logURL)

        if portInUse(preferredPort) {
            if probeEtude(preferredPort) { return open() }      // already running (terminal install or another window)
            port = freePort()
        }
        // First launch: a fresh collection gets the showcase deck, so there's something to try.
        if !FileManager.default.fileExists(atPath: home.appendingPathComponent("etude.db").path) {
            _ = run(["pack", "import", appDir.appendingPathComponent("examples/showcase.pack.json").path], wait: true)
        }
        server = run(["serve", "--port", String(port)], wait: false)
        for _ in 0..<150 {                                      // up to 30 s
            if probeEtude(port) { return open() }
            if let s = server, !s.isRunning { break }
            Thread.sleep(forTimeInterval: 0.2)
        }
        DispatchQueue.main.async {
            self.showMessage("Etude didn't start.", detail: "The log is in ~/Library/Logs/Etude.log. ⌘R tries again.")
        }
    }

    func run(_ args: [String], wait: Bool) -> Process? {
        let p = Process()
        p.executableURL = nodeBin
        p.arguments = [appDir.appendingPathComponent("bin/etude.js").path] + args
        p.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["ETUDE_HOME"] = env["ETUDE_HOME"] ?? home.path
        env["NODE_NO_WARNINGS"] = "1"
        p.environment = env
        if let l = log { p.standardOutput = l; p.standardError = l }
        do { try p.run() } catch { return nil }
        if wait { p.waitUntilExit() }
        return p
    }

    func open() {
        DispatchQueue.main.async { self.web.load(URLRequest(url: self.base)) }
    }

    func showMessage(_ title: String, detail: String) {
        let html = """
        <html><body style="background:#0b0b0d;color:#ddd;font:15px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="max-width:440px;text-align:center"><div style="font:64px 'Times New Roman',serif;color:#f472b6">ε</div>
        <p>\(title)</p><p style="color:#888;font-size:13px">\(detail)</p></div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    func applicationWillTerminate(_ n: Notification) {
        if let s = server, s.isRunning { s.terminate(); s.waitUntilExit() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // Links outside Etude open in the default browser.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, a.navigationType == .linkActivated, u.host != "127.0.0.1" {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { if u.host == "127.0.0.1" { w.load(a.request) } else { NSWorkspace.shared.open(u) } }
        return nil
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel(); o.allowsMultipleSelection = p.allowsMultipleSelection
        completionHandler(o.runModal() == .OK ? o.urls : nil)
    }

    @objc func reload() {
        if web.url?.host == "127.0.0.1" { web.reload() } else { DispatchQueue.global().async { if probeEtude(self.port) { self.open() } else { self.start() } } }
    }
    @objc func home_() { open() }
    @objc func back() { web.goBack() }
    @objc func fwd() { web.goForward() }
    @objc func zoomIn() { web.pageZoom += 0.1 }
    @objc func zoomOut() { web.pageZoom = max(0.5, web.pageZoom - 0.1) }
    @objc func zoomReset() { web.pageZoom = 1 }
    @objc func openInBrowser() { NSWorkspace.shared.open(web.url?.host == "127.0.0.1" ? web.url! : base) }
    @objc func showData() { NSWorkspace.shared.activateFileViewerSelecting([home.appendingPathComponent("etude.db")]) }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Etude", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Etude", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        file.addItem(withTitle: "Show Collection in Finder", action: #selector(showData), keyEquivalent: "")
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Home", action: #selector(home_), keyEquivalent: "H")
        view.addItem(withTitle: "Back", action: #selector(back), keyEquivalent: "[")
        view.addItem(withTitle: "Forward", action: #selector(fwd), keyEquivalent: "]")
        view.addItem(.separator())
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        view.items.last?.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = win
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
