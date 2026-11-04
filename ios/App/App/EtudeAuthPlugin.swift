import Foundation
import Network
import SafariServices
import Security
import UIKit
import Capacitor

/// Sign in with ChatGPT for the web app inside the iOS shell (src/browser/native-chatgpt.ts).
///
/// OpenAI's flow for open-source clients redirects to an HTTP listener on 127.0.0.1. The app runs
/// that listener itself and shows the sign-in page in a Safari sheet on the same phone, so the
/// redirect lands here. The page also can't call auth.openai.com from the WebView (no CORS), so
/// requests to OpenAI go through URLSession, and the two credential files live in the Keychain.
@objc(EtudeAuthPlugin)
public class EtudeAuthPlugin: CAPPlugin, CAPBridgedPlugin, SFSafariViewControllerDelegate {
    public let identifier = "EtudeAuthPlugin"
    public let jsName = "EtudeAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
    ]

    /// Only OpenAI's sign-in and API hosts: this is not a general way around the WebView's CORS.
    static let allowedHosts: Set<String> = ["auth.openai.com", "api.openai.com"]
    /// Only the two ChatGPT credential files.
    static let allowedNames: Set<String> = ["chatgpt.json", "chatgpt-host-id"]

    // MARK: - HTTP

    @objc func request(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https", let host = url.host, Self.allowedHosts.contains(host) else {
            call.reject("only https requests to OpenAI's sign-in and API hosts are allowed", "forbidden")
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = call.getString("method") ?? "GET"
        req.timeoutInterval = max(1, (call.getDouble("timeoutMs") ?? 30000) / 1000)
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        for (k, v) in call.getObject("headers") ?? [:] {
            if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) }
        }
        if let body = call.getString("body") { req.httpBody = body.data(using: .utf8) }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        let session = URLSession(configuration: config)
        session.dataTask(with: req) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            if let error = error {
                let timedOut = (error as NSError).code == NSURLErrorTimedOut
                call.reject(timedOut ? "the request timed out" : error.localizedDescription, timedOut ? "timeout" : "network")
                return
            }
            guard let http = response as? HTTPURLResponse else {
                call.reject("no HTTP response", "network")
                return
            }
            var headers: [String: String] = [:]
            for (k, v) in http.allHeaderFields {
                if let k = k as? String, let v = v as? String { headers[k.lowercased()] = v }
            }
            call.resolve([
                "status": http.statusCode,
                "headers": headers,
                "body": String(decoding: data ?? Data(), as: UTF8.self),
            ])
        }.resume()
    }

    // MARK: - Keychain

    private func keychainQuery(_ name: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "study.etude.app.chatgpt",
            kSecAttrAccount as String: name,
        ]
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Self.allowedNames.contains(name) else {
            call.reject("unknown credential name", "forbidden")
            return
        }
        var q = keychainQuery(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else if status == errSecSuccess, let data = item as? Data {
            call.resolve(["value": String(decoding: data, as: UTF8.self)])
        } else {
            call.reject("Keychain read failed (\(status))", "keychain")
        }
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Self.allowedNames.contains(name), let value = call.getString("value") else {
            call.reject("unknown credential name", "forbidden")
            return
        }
        let q = keychainQuery(name)
        let data = Data(value.utf8)
        // This device only, readable after the first unlock (grading can run with the phone locked).
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add.merge(attrs) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status == errSecSuccess { call.resolve() } else { call.reject("Keychain write failed (\(status))", "keychain") }
    }

    // MARK: - loopback listener

    private let queue = DispatchQueue(label: "study.etude.auth.loopback")
    private var listener: NWListener?
    private var hits: [[String: String]] = []
    private var waiting: CAPPluginCall?
    private var cancelled = false
    private var sheet: SFSafariViewController?

    @objc func listen(_ call: CAPPluginCall) {
        let preferred = call.getInt("port") ?? 1455
        queue.async {
            self.stopListener()
            self.hits = []
            self.cancelled = false
            for port in [preferred, 0] {
                if let l = self.startListener(port: port) {
                    self.listener = l
                    // NWListener reports the bound port once it is ready.
                    let ready = DispatchSemaphore(value: 0)
                    var failed: NWError?
                    l.stateUpdateHandler = { state in
                        switch state {
                        case .ready: ready.signal()
                        case .failed(let e): failed = e; ready.signal()
                        default: break
                        }
                    }
                    l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
                    l.start(queue: DispatchQueue.global(qos: .userInitiated))
                    _ = ready.wait(timeout: .now() + 5)
                    if failed == nil, let p = l.port?.rawValue, p != 0 {
                        call.resolve(["port": Int(p)])
                        return
                    }
                    l.cancel()
                    self.listener = nil
                }
            }
            call.reject("couldn't listen on 127.0.0.1", "listen_failed")
        }
    }

    private func startListener(port: Int) -> NWListener? {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port)) ?? .any)
        return try? NWListener(using: params)
    }

    private func stopListener() {
        listener?.cancel()
        listener = nil
    }

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self = self else { return conn.cancel() }
            let text = String(decoding: data ?? Data(), as: UTF8.self)
            // "GET /auth/callback?code=…&state=… HTTP/1.1"
            let target = text.split(separator: "\r\n", maxSplits: 1).first?.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            let path = parts.first.map(String.init) ?? "/"
            let query = parts.count > 1 ? String(parts[1]) : ""
            let isCallback = path == "/auth/callback"
            let page = isCallback
                ? "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Etude</title><body style=\"font:17px/1.5 -apple-system,system-ui,sans-serif;margin:4rem auto;max-width:28rem;padding:0 1.5rem;background:#0f0f0f;color:#f2f2f2\"><h1 style=\"font-size:1.2rem\">Back to Etude…</h1><p>You can close this page.</p></body>"
                : "not found"
            let head = "HTTP/1.1 \(isCallback ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(page.utf8.count)\r\n\r\n"
            conn.send(content: Data((head + page).utf8), completion: .contentProcessed { _ in conn.cancel() })
            self.hits.append(["path": path, "query": query])
            self.drain()
        }
    }

    /// Hands the oldest callback to a waiting `next`, or tells it the sign-in was cancelled.
    private func drain() {
        guard let call = waiting else { return }
        if !hits.isEmpty {
            waiting = nil
            call.resolve(hits.removeFirst())
            bridge?.releaseCall(call)
        } else if cancelled {
            waiting = nil
            call.reject("ChatGPT sign-in was cancelled", "cancelled")
            bridge?.releaseCall(call)
        }
    }

    @objc func next(_ call: CAPPluginCall) {
        call.keepAlive = true
        queue.async {
            if let old = self.waiting {
                old.reject("superseded", "cancelled")
                self.bridge?.releaseCall(old)
            }
            self.waiting = call
            self.drain()
        }
    }

    // MARK: - browser sheet

    @objc func open(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https", let host = url.host, Self.allowedHosts.contains(host) else {
            call.reject("only OpenAI's sign-in page can be opened here", "forbidden")
            return
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no view to present the sign-in page from", "open_failed")
                return
            }
            let config = SFSafariViewController.Configuration()
            config.entersReaderIfAvailable = false
            let vc = SFSafariViewController(url: url, configuration: config)
            vc.delegate = self
            vc.dismissButtonStyle = .cancel
            vc.modalPresentationStyle = .pageSheet
            self.sheet = vc
            presenter.present(vc, animated: true) { call.resolve() }
        }
    }

    /// The person tapped Cancel in the sheet.
    public func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        sheet = nil
        queue.async {
            self.cancelled = true
            self.stopListener()
            self.drain()
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        queue.async {
            self.cancelled = true
            self.stopListener()
            self.drain()
            DispatchQueue.main.async {
                if let vc = self.sheet {
                    self.sheet = nil
                    vc.dismiss(animated: true) { call.resolve() }
                } else {
                    call.resolve()
                }
            }
        }
    }
}
