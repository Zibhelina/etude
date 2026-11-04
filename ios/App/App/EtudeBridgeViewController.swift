import Capacitor

/// The app's Capacitor view controller: registers the plugins that live in this target.
class EtudeBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(EtudeAuthPlugin())
        bridge?.registerPluginInstance(EtudeStorePlugin())
    }
}
