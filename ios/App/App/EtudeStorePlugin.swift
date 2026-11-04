import Foundation
import StoreKit
import UIKit
import Capacitor

/// Etude Sync through Apple In-App Purchase (StoreKit 2), for the web app inside the iOS shell.
///
/// The page loads the products (prices come from the App Store, localized), buys with the
/// appAccountToken the Sync server gives for the signed-in Etude account, and sends each signed
/// transaction (JWS) to the server. A transaction is finished only after the page says the server
/// accepted it (`finish`), so one that never reached the server is offered again on the next launch
/// (`unfinished`) and through the `transaction` event that `Transaction.updates` feeds.
@objc(EtudeStorePlugin)
public class EtudeStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EtudeStorePlugin"
    public let jsName = "EtudeStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise),
    ]

    private var updates: Task<Void, Never>?

    override public func load() {
        // Renewals, purchases approved later (Ask to Buy), refunds and purchases made on another device.
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                self?.notifyListeners("transaction", data: EtudeStore.describe(result), retainUntilConsumed: true)
            }
        }
    }

    deinit { updates?.cancel() }

    // MARK: - products

    @objc func getProducts(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        Task {
            do {
                call.resolve(["products": try await EtudeStore.products(ids)])
            } catch {
                call.reject("Couldn't load the App Store products: \(error.localizedDescription)", "products_failed")
            }
        }
    }

    // MARK: - buying

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), let token = call.getString("appAccountToken").flatMap(UUID.init(uuidString:)) else {
            call.reject("productId and a UUID appAccountToken are required", "invalid")
            return
        }
        Task { @MainActor in
            do {
                guard let out = try await EtudeStore.purchase(productId, token: token, scene: self.windowScene()) else {
                    call.reject("That product isn't available in the App Store.", "no_product")
                    return
                }
                call.resolve(out)
            } catch {
                call.reject("The purchase didn't go through: \(error.localizedDescription)", "purchase_failed")
            }
        }
    }

    /// Finishes a transaction once the Sync server accepted it.
    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId").flatMap(UInt64.init) else {
            call.reject("transactionId is required", "invalid")
            return
        }
        Task { call.resolve(["finished": await EtudeStore.finish(id)]) }
    }

    @objc func unfinished(_ call: CAPPluginCall) {
        Task { call.resolve(["transactions": await EtudeStore.unfinished()]) }
    }

    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task {
            call.resolve(["transactions": await EtudeStore.entitlements()])
        }
    }

    /// Restore Purchases: asks the App Store for this Apple ID's transactions (may ask to sign in), then lists the current ones.
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
            } catch StoreKitError.userCancelled {
                call.resolve(["cancelled": true, "transactions": []])
                return
            } catch {
                call.reject("Couldn't reach the App Store: \(error.localizedDescription)", "restore_failed")
                return
            }
            call.resolve(["cancelled": false, "transactions": await EtudeStore.entitlements()])
        }
    }

    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = self.windowScene() else {
                call.reject("No window to show the subscriptions sheet in.", "no_window")
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve()
            } catch {
                call.reject("Couldn't open subscriptions: \(error.localizedDescription)", "manage_failed")
            }
        }
    }

    // MARK: - helpers

    @MainActor private func windowScene() -> UIWindowScene? {
        bridge?.viewController?.view.window?.windowScene
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    }
}

/// StoreKit 2 calls behind the plugin, as plain values the bridge (and the tests) can use.
enum EtudeStore {
    static func products(_ ids: [String]) async throws -> [[String: Any]] {
        try await Product.products(for: ids).sorted { $0.price < $1.price }.map(describe)
    }

    /// Buys `productId` for the Etude account behind `token`. nil when the App Store doesn't know the product.
    @MainActor static func purchase(_ productId: String, token: UUID, scene: UIWindowScene?) async throws -> [String: Any]? {
        guard let product = try await Product.products(for: [productId]).first else { return nil }
        let result: Product.PurchaseResult
        if #available(iOS 17.0, *), let scene {
            result = try await product.purchase(confirmIn: scene, options: [.appAccountToken(token)])
        } else {
            result = try await product.purchase(options: [.appAccountToken(token)])
        }
        switch result {
        case .success(let verification):
            var out = describe(verification)
            out["status"] = "purchased"
            return out
        case .pending: return ["status": "pending"]
        case .userCancelled: return ["status": "cancelled"]
        @unknown default: return ["status": "unknown"]
        }
    }

    static func finish(_ id: UInt64) async -> Bool {
        for await result in Transaction.unfinished {
            switch result {
            case .verified(let t) where t.id == id, .unverified(let t, _) where t.id == id:
                await t.finish()
                return true
            default: continue
            }
        }
        return false
    }

    static func unfinished() async -> [[String: Any]] {
        var list: [[String: Any]] = []
        for await result in Transaction.unfinished { list.append(describe(result)) }
        return list
    }

    static func entitlements() async -> [[String: Any]] {
        var list: [[String: Any]] = []
        for await result in Transaction.currentEntitlements { list.append(describe(result)) }
        return list
    }

    static func describe(_ result: VerificationResult<Transaction>) -> [String: Any] {
        let t: Transaction
        var verified = true
        switch result {
        case .verified(let v): t = v
        case .unverified(let v, _): t = v; verified = false
        }
        var out: [String: Any] = [
            "jws": result.jwsRepresentation,
            "verified": verified,
            "transactionId": String(t.id),
            "originalTransactionId": String(t.originalID),
            "productId": t.productID,
        ]
        if let e = t.expirationDate { out["expires"] = ISO8601DateFormatter().string(from: e) }
        if let r = t.revocationDate { out["revoked"] = ISO8601DateFormatter().string(from: r) }
        return out
    }

    static func describe(_ p: Product) -> [String: Any] {
        var out: [String: Any] = [
            "id": p.id,
            "displayName": p.displayName,
            "description": p.description,
            "displayPrice": p.displayPrice,
        ]
        if let s = p.subscription {
            let unit: String
            switch s.subscriptionPeriod.unit {
            case .day: unit = "day"
            case .week: unit = "week"
            case .month: unit = "month"
            case .year: unit = "year"
            @unknown default: unit = "unknown"
            }
            out["period"] = ["unit": unit, "value": s.subscriptionPeriod.value]
            out["groupId"] = s.subscriptionGroupID
            if let offer = s.introductoryOffer {
                out["introOffer"] = ["displayPrice": offer.displayPrice, "periodValue": offer.period.value, "paymentMode": String(describing: offer.paymentMode)]
            }
        }
        return out
    }
}
