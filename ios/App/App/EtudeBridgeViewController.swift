import Capacitor
import WebKit

/// The app's Capacitor view controller: registers the plugins that live in this target, and keeps the native bridge
/// to the app's own page.
class EtudeBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(EtudeAuthPlugin())
        bridge?.registerPluginInstance(EtudeStorePlugin())
        keepBridgeToMainFrame()
    }

    /// WebKit gives every frame `window.webkit.messageHandlers.bridge`, card frames included, and Capacitor runs any
    /// plugin call that reaches it. Cards are other people's code, so only the app's own page may call a plugin: the
    /// handler Capacitor registered is put behind one that drops messages from any other frame. (On Android, Capacitor
    /// already checks the frame.)
    private func keepBridgeToMainFrame() {
        guard let handler = (bridge as? CapacitorBridge)?.webViewDelegationHandler else { return }
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: MainFrameOnly.name)
        controller.add(MainFrameOnly(handler), name: MainFrameOnly.name)
    }
}

/// Passes a script message on to Capacitor's handler only when it comes from the main frame.
final class MainFrameOnly: NSObject, WKScriptMessageHandler {
    /// The name Capacitor's bridge script posts to (WebViewDelegationHandler.handlerName).
    static let name = "bridge"
    /// Weak: the bridge keeps Capacitor's handler alive, and the content controller keeps this one.
    private weak var next: WKScriptMessageHandler?

    init(_ next: WKScriptMessageHandler) {
        self.next = next
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        next?.userContentController(userContentController, didReceive: message)
    }
}
