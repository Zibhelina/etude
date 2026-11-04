import XCTest
import StoreKit
import StoreKitTest
import WebKit
import Capacitor
@testable import App

/// StoreKit testing against Etude.storekit (no App Store account, no network to Apple).
///
/// `testProductsAndPurchase` needs nothing else. `testSyncThroughThePage1Subscribe` and `…2Restore` drive
/// the real page in the host app (Settings → Sync, Subscribe, Restore Purchases) against a local
/// etude-cloud and run only when these are set, as TEST_RUNNER_* env for xcodebuild or in
/// /tmp/etude-iap-test.json for runs started from Xcode:
///   ETUDE_TEST_SERVER  the Sync server, e.g. http://127.0.0.1:4899 (with ETUDE_CLOUD_APPLE_ENVIRONMENTS
///                      including Xcode and ETUDE_CLOUD_APPLE_XCODE_ROOT set to Xcode's certificate)
///   ETUDE_TEST_CODES   a URL that answers the last sign-in code sent to ?email=
///   ETUDE_TEST_SHOTS   a folder for screenshots and the first transaction's JWS
final class EtudeStoreTests: XCTestCase {
    /// The environment, plus /tmp/etude-iap-test.json when it exists (runs started from Xcode's UI can't pass env).
    let env: [String: String] = {
        var e = ProcessInfo.processInfo.environment
        if let d = FileManager.default.contents(atPath: "/tmp/etude-iap-test.json"), let extra = try? JSONSerialization.jsonObject(with: d) as? [String: String] {
            e.merge(extra) { _, new in new }
        }
        return e
    }()

    func testProductsAndPurchase() async throws {
        // SKTestSession needs Xcode's StoreKit test server for this simulator, which exists after the app has been run
        // from Xcode once with the scheme's StoreKit configuration; without it the session's settings don't apply.
        let session = try SKTestSession(configurationFileNamed: "Etude")
        session.disableDialogs = true
        var products = try await EtudeStore.products(["study.etude.sync.monthly", "study.etude.sync.yearly"])
        for _ in 0..<10 where products.count < 2 {
            try await Task.sleep(nanoseconds: 500_000_000)
            products = try await EtudeStore.products(["study.etude.sync.monthly", "study.etude.sync.yearly"])
        }
        if let dir = env["ETUDE_TEST_SHOTS"], let d = try? JSONSerialization.data(withJSONObject: products) { try? d.write(to: URL(fileURLWithPath: dir + "/products.json")) }
        try XCTSkipIf(products.count < 2, "StoreKit returned \(products.count) products from Etude.storekit")
        XCTAssertEqual(products.map { $0["id"] as? String }, ["study.etude.sync.monthly", "study.etude.sync.yearly"])
        XCTAssertEqual(products.map { $0["displayPrice"] as? String }, ["$9.99", "$49.99"])
        XCTAssertEqual((products[0]["period"] as? [String: Any])?["unit"] as? String, "month")
        XCTAssertEqual((products[1]["period"] as? [String: Any])?["unit"] as? String, "year")

        // Buying needs StoreKit's purchase sheet off (Etude.storekit `_disableDialogs`, synced by running from Xcode).
        guard env["ETUDE_TEST_PURCHASE"] == "1" else { return }
        let token = UUID()
        let out = try await EtudeStore.purchase("study.etude.sync.monthly", token: token, scene: nil)
        XCTAssertEqual(out?["status"] as? String, "purchased")
        let jws = try XCTUnwrap(out?["jws"] as? String)
        // The signed payload carries the account token the server matches.
        let payload = try JSONSerialization.jsonObject(with: Self.b64url(jws.split(separator: ".")[1])) as? [String: Any]
        XCTAssertEqual((payload?["appAccountToken"] as? String)?.lowercased(), token.uuidString.lowercased())
        XCTAssertEqual(payload?["environment"] as? String, "Xcode")
        if let dir = env["ETUDE_TEST_SHOTS"] { try jws.write(toFile: dir + "/first.jws", atomically: true, encoding: .utf8) }

        // Unfinished until finished; then current.
        let id = try XCTUnwrap(UInt64(out?["transactionId"] as? String ?? ""))
        let before = await EtudeStore.unfinished()
        XCTAssertTrue(before.contains { $0["transactionId"] as? String == String(id) })
        let finished = await EtudeStore.finish(id)
        XCTAssertTrue(finished)
        let after = await EtudeStore.unfinished()
        XCTAssertFalse(after.contains { $0["transactionId"] as? String == String(id) })
        let current = await EtudeStore.entitlements()
        XCTAssertEqual(current.first?["productId"] as? String, "study.etude.sync.monthly")
    }

    /// Signs in to the local server, shows the plans, subscribes to monthly. The App Store sheet must be off
    /// (Etude.storekit `_disableDialogs`, synced by running the app from Xcode) or confirmed by hand.
    func testSyncThroughThePage1Subscribe() async throws {
        let (web, shots) = try await pageReady()
        // ETUDE_TEST_EMAIL: the account the simulator's subscription already belongs to (the App Store keeps one
        // subscription per Apple Account, and the server binds it to the account it was bought for).
        let email = env["ETUDE_TEST_EMAIL"] ?? "iap-\(Int(Date().timeIntervalSince1970))@example.com"
        let st0 = try await api(web, "GET", "/api/account") as? [String: Any]
        if st0?["signedIn"] as? Bool == true { _ = try await api(web, "POST", "/api/account/signout") }
        _ = try await api(web, "PUT", "/api/account/server", ["server": env["ETUDE_TEST_SERVER"]!])
        _ = try await api(web, "POST", "/api/account/signin", ["email": email])
        try await Task.sleep(nanoseconds: 500_000_000)
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(env["ETUDE_TEST_CODES"]!)?email=\(email)")!)
        let code = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(code.count, 6, "sign-in code")
        _ = try await api(web, "POST", "/api/account/verify", ["code": code, "email": email])

        // Settings → Sync shows the App Store plans with StoreKit's prices.
        try await openSync(web)
        try await waitFor("plans", web, "document.querySelectorAll('[data-appstore-plans] [data-product]').length === 2", timeout: 60)
        let plansText = try await js(web, "return document.querySelector('[data-appstore-plans]').innerText") as? String ?? ""
        XCTAssertTrue(plansText.contains("$9.99") && plansText.contains("$49.99"), plansText)
        XCTAssertTrue(plansText.contains("Restore Purchases") && plansText.contains("renews automatically"), plansText)
        _ = try await js(web, "document.querySelector('[data-plan]').scrollIntoView({block: 'start'}); return true")
        try await shot(web, shots, "1-plans")
        _ = try await js(web, "document.querySelector('[data-subscription-terms]').scrollIntoView({block: 'center'}); return true")
        try await shot(web, shots, "2-plans-terms")

        // Subscribe to monthly: StoreKit → the page → the server.
        _ = try await js(web, "document.querySelector('[data-product=\"study.etude.sync.monthly\"]').click(); return true")
        try await Task.sleep(nanoseconds: 400_000_000)
        _ = try await js(web, "document.querySelector('[data-subscribe]').click(); return true")
        try await waitFor("sync on", web, "document.querySelector('[data-plan-state]')?.dataset.planState === 'active' || !!document.querySelector('[data-appstore-plans] [role=alert]')", timeout: 60)
        try await shot(web, shots, "3-after-subscribe")
        if let dir = shots { try await dumpTransactions(dir) }
        let st = try await api(web, "GET", "/api/account") as? [String: Any]
        XCTAssertEqual((st?["billing"] as? [String: Any])?["source"] as? String, "apple")
        let left = await EtudeStore.unfinished()
        XCTAssertTrue(left.isEmpty, "finished after the server accepted it")

        // Restore Purchases sends the App Store's current subscription again; Sync stays on.
        _ = try await js(web, "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore Purchases').click(); return true")
        try await Task.sleep(nanoseconds: 4_000_000_000)
        try await waitFor("still on", web, "document.querySelector('[data-plan-state]')?.dataset.planState === 'active'")

        // With Etude.storekit's time rate at "monthly renewal every 30 seconds", a renewal arrives through
        // Transaction.updates and the page sends it on its own.
        let first = await EtudeStore.entitlements().first?["transactionId"] as? String
        try await Task.sleep(nanoseconds: 40_000_000_000)
        let now = await EtudeStore.entitlements().first?["transactionId"] as? String
        XCTAssertNotEqual(first, now, "renewed")
        let after = await EtudeStore.unfinished()
        XCTAssertTrue(after.isEmpty, "the renewal was sent and finished")
        _ = try await js(web, "document.querySelector('[data-plan]').scrollIntoView({block: 'start'}); return true")
        try await shot(web, shots, "4-renewed")
        if let dir = shots { try await dumpTransactions(dir) }
    }

    /// After the subscription lapsed (StoreKit testing stops renewing once the app quits): Sync is off, and
    /// Restore Purchases says the subscription ended.
    func testSyncThroughThePage2Ended() async throws {
        let (web, shots) = try await pageReady()
        try await waitFor("sync off on the server", web, "(async () => { const a = await (await window.__etudeTransport('/api/account')).json(); return !!a.me && a.me.sync.active === false })()", timeout: 120)
        try await openSync(web)
        try await waitFor("plan block", web, "document.querySelector('[data-plan-state]')?.dataset.planState !== 'active'")
        _ = try await js(web, "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore Purchases').click(); return true")
        try await Task.sleep(nanoseconds: 4_000_000_000)
        _ = try await js(web, "document.querySelector('[data-plan]').scrollIntoView({block: 'start'}); return true")
        try await shot(web, shots, "5-ended")
        if let dir = shots { try await dumpTransactions(dir) }
    }

    /// Every StoreKit transaction for the app, for the report (and Xcode's signing certificate from the first JWS).
    func dumpTransactions(_ dir: String) async throws {
        var all: [[String: Any]] = []
        for await r in Transaction.all {
            var d: [String: Any] = ["jws": r.jwsRepresentation]
            if case .verified(let t) = r { d["id"] = String(t.id); d["product"] = t.productID; d["expires"] = t.expirationDate?.description ?? ""; d["revoked"] = t.revocationDate?.description ?? "" }
            all.append(d)
        }
        try JSONSerialization.data(withJSONObject: all, options: .prettyPrinted).write(to: URL(fileURLWithPath: dir + "/transactions.json"))
    }

    func pageReady() async throws -> (WKWebView, String?) {
        guard env["ETUDE_TEST_SERVER"] != nil, env["ETUDE_TEST_CODES"] != nil else { throw XCTSkip("set ETUDE_TEST_SERVER and ETUDE_TEST_CODES (env or /tmp/etude-iap-test.json)") }
        let web = try await webView()
        try await waitFor("page", web, "typeof window.__etudeTransport === 'function' && typeof window.__etudeStoreKit === 'object'")
        // First launch opens the setup; skip it.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        _ = try await js(web, "const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Skip'); if (b) b.click(); return !!b")
        try await Task.sleep(nanoseconds: 800_000_000)
        return (web, env["ETUDE_TEST_SHOTS"])
    }

    @MainActor func openSync(_ web: WKWebView) async throws {
        _ = try await js(web, "history.pushState(null, '', '/settings#sync'); dispatchEvent(new PopStateEvent('popstate')); return true")
        try await Task.sleep(nanoseconds: 800_000_000)
    }

    // MARK: - helpers

    @MainActor func webView() async throws -> WKWebView {
        for _ in 0..<100 {
            let vc = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first?.rootViewController as? CAPBridgeViewController }.first
            if let w = vc?.webView { return w }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw XCTSkip("no web view")
    }

    @MainActor func js(_ web: WKWebView, _ body: String, _ args: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(body, arguments: args, in: nil, contentWorld: .page)
    }

    /// A request to the app's own /api, the way the page makes it (through the core in the page).
    @MainActor func api(_ web: WKWebView, _ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> Any? {
        let json = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
        return try await js(web, """
        const r = await window.__etudeTransport(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : (json || '{}') });
        const t = await r.text();
        if (!r.ok) throw new Error(method + ' ' + path + ' ' + r.status + ' ' + t);
        return t ? JSON.parse(t) : null;
        """, ["path": path, "method": method, "json": json])
    }

    @MainActor func waitFor(_ what: String, _ web: WKWebView, _ expr: String, timeout: Double = 20) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if (try? await js(web, "return await (\(expr))")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        let text = (try? await js(web, "const b = document.querySelector('[data-plan]'); return (b ? b.parentElement.parentElement.innerText : document.body.innerText).slice(0, 1500)")) as? String ?? ""
        XCTFail("timed out waiting for \(what). Page: \(text)")
        throw XCTSkip("stopped")
    }

    @MainActor func shot(_ web: WKWebView, _ dir: String?, _ name: String) async throws {
        guard let dir else { return }
        let img = try await web.takeSnapshot(configuration: nil)
        try img.pngData()?.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
    }

    static func b64url<S: StringProtocol>(_ s: S) -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t) ?? Data()
    }
}
