package study.etude.app

import android.content.Intent
import android.net.Uri
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Etude Sync through Google Play Billing, with the same JavaScript shape as the iOS plugin
 * (ios/App/App/EtudeStorePlugin.swift), so web/src/lib/storekit.ts drives both.
 *
 * A plan is "productId:basePlanId" (etude_sync:monthly). Prices come from Play, localized. A purchase
 * is bought with obfuscatedAccountId = the token the Sync server gives for the signed-in account and
 * is acknowledged ("finished") only after the server accepted it; Play refunds anything left
 * unacknowledged for three days, which is what should happen to a purchase the server refused.
 */
@CapacitorPlugin(name = "EtudeStore")
class EtudeStorePlugin : Plugin(), PurchasesUpdatedListener {
    private lateinit var client: BillingClient
    private val details = HashMap<String, ProductDetails>()
    private var purchaseCall: PluginCall? = null
    private var purchaseProduct: String? = null
    private val waiting = ArrayList<(BillingResult) -> Unit>()
    private var connecting = false

    override fun load() {
        client = BillingClient.newBuilder(context)
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build()
    }

    override fun handleOnDestroy() {
        if (::client.isInitialized) client.endConnection()
    }

    /** Runs `then` once Play's billing service is connected, or rejects `call` when it can't be. */
    private fun ready(call: PluginCall, then: () -> Unit) {
        if (client.isReady) return then()
        synchronized(waiting) {
            waiting.add { r ->
                if (r.responseCode == BillingClient.BillingResponseCode.OK) then()
                else fail(call, r, "Couldn't reach Google Play.")
            }
            if (connecting) return
            connecting = true
        }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) = flush(result)
            override fun onBillingServiceDisconnected() {
                synchronized(waiting) { connecting = false }
            }
        })
    }

    private fun flush(result: BillingResult) {
        val todo: List<(BillingResult) -> Unit>
        synchronized(waiting) {
            todo = ArrayList(waiting)
            waiting.clear()
            connecting = false
        }
        todo.forEach { it(result) }
    }

    @PluginMethod
    fun getProducts(call: PluginCall) {
        val ids = call.getArray("ids")?.toList<String>() ?: emptyList()
        val byProduct = ids.mapNotNull { split(it) }.groupBy({ it.first }, { it.second })
        if (byProduct.isEmpty()) return call.resolve(JSObject().put("products", JSArray()))
        ready(call) {
            val params = QueryProductDetailsParams.newBuilder().setProductList(
                byProduct.keys.map {
                    QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(BillingClient.ProductType.SUBS).build()
                }
            ).build()
            client.queryProductDetailsAsync(params) { result, res ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    fail(call, result, "Google Play didn't return the plans.")
                    return@queryProductDetailsAsync
                }
                val out = JSArray()
                for (pd in res.productDetailsList) {
                    details[pd.productId] = pd
                    for (plan in byProduct[pd.productId].orEmpty()) {
                        // The base plan itself (no offer id): its last phase is the recurring price.
                        val offer = pd.subscriptionOfferDetails?.firstOrNull { it.basePlanId == plan && it.offerId == null } ?: continue
                        val phase = offer.pricingPhases.pricingPhaseList.lastOrNull() ?: continue
                        val period = period(phase.billingPeriod)
                        out.put(JSObject().apply {
                            put("id", "${pd.productId}:$plan")
                            put("displayName", planName(pd.name.ifBlank { pd.title }, period))
                            put("description", pd.description)
                            put("displayPrice", phase.formattedPrice)
                            put("currency", phase.priceCurrencyCode)
                            if (period != null) put("period", JSObject().put("unit", period.first).put("value", period.second))
                        })
                    }
                }
                call.resolve(JSObject().put("products", out))
            }
        }
    }

    @PluginMethod
    fun purchase(call: PluginCall) {
        val id = call.getString("productId") ?: return call.reject("productId is required.")
        val account = call.getString("appAccountToken") ?: return call.reject("appAccountToken is required.")
        val (productId, plan) = split(id) ?: return call.reject("Unknown plan $id.")
        if (purchaseCall != null) return call.reject("A purchase is already in progress.", "busy")
        ready(call) {
            val pd = details[productId] ?: return@ready call.reject("Load the plans first.", "not_loaded")
            val offer = pd.subscriptionOfferDetails?.firstOrNull { it.basePlanId == plan && it.offerId == null }
                ?: return@ready call.reject("Google Play has no $plan plan.", "not_loaded")
            val flow = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd).setOfferToken(offer.offerToken).build()))
                .setObfuscatedAccountId(account)
                .build()
            purchaseCall = call
            purchaseProduct = productId
            activity.runOnUiThread {
                val r = client.launchBillingFlow(activity, flow)
                if (r.responseCode != BillingClient.BillingResponseCode.OK) settle { fail(it, r, "Google Play couldn't start the purchase.") }
            }
        }
    }

    /** Play's answer to launchBillingFlow, and purchases that complete later (a pending one paid). */
    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val list = purchases.orEmpty()
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val mine = list.firstOrNull { p -> purchaseProduct == null || p.products.contains(purchaseProduct) }
                val answered = if (purchaseCall != null && mine != null) mine else null
                if (answered != null) {
                    val st = if (answered.purchaseState == Purchase.PurchaseState.PURCHASED) "purchased" else "pending"
                    settle { it.resolve(tx(answered).put("status", st)) }
                }
                // Every other paid purchase (a pending one that went through, a renewal bought elsewhere) goes to the page's listener.
                list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED && it !== answered }.forEach { notifyListeners("transaction", tx(it)) }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> settle { it.resolve(JSObject().put("status", "cancelled")) }
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> {
                // Already subscribed on this Google account: hand back the existing purchase so the page can send it.
                val product = purchaseProduct
                query { r, owned ->
                    val p = owned.firstOrNull { it.purchaseState == Purchase.PurchaseState.PURCHASED && (product == null || it.products.contains(product)) }
                    settle { c -> if (p != null) c.resolve(tx(p).put("status", "purchased")) else c.reject(r.debugMessage.ifBlank { "This Google account already has the subscription." }, "owned") }
                }
            }
            else -> settle { fail(it, result, "Google Play couldn't finish the purchase.") }
        }
    }

    private fun settle(fn: (PluginCall) -> Unit) {
        val c = purchaseCall ?: return
        purchaseCall = null
        purchaseProduct = null
        fn(c)
    }

    /** Acknowledges a purchase the Sync server accepted. */
    @PluginMethod
    fun finish(call: PluginCall) {
        val token = call.getString("transactionId") ?: return call.reject("transactionId is required.")
        ready(call) {
            client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()) { r ->
                if (r.responseCode == BillingClient.BillingResponseCode.OK) call.resolve(JSObject().put("finished", true))
                else fail(call, r, "Couldn't acknowledge the purchase.")
            }
        }
    }

    /** Paid purchases not acknowledged yet (the server hadn't taken them, e.g. the app closed mid-purchase). */
    @PluginMethod
    fun unfinished(call: PluginCall) = ready(call) {
        query { r, list -> answer(call, r, "transactions", list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED && !it.isAcknowledged }) }
    }

    @PluginMethod
    fun currentEntitlements(call: PluginCall) = ready(call) {
        query { r, list -> answer(call, r, "transactions", list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }) }
    }

    /** Play has no restore sheet: the subscriptions this Google account holds are listed and sent again. */
    @PluginMethod
    fun restore(call: PluginCall) = ready(call) {
        query { r, list ->
            if (r.responseCode != BillingClient.BillingResponseCode.OK) return@query fail(call, r, "Google Play didn't answer.")
            val arr = JSArray()
            list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { arr.put(tx(it)) }
            call.resolve(JSObject().put("cancelled", false).put("transactions", arr))
        }
    }

    /** The Play Store's page for this subscription (cancel, change plan, payment method). */
    @PluginMethod
    fun manageSubscriptions(call: PluginCall) {
        val sku = call.getString("productId") ?: details.keys.firstOrNull() ?: "etude_sync"
        val uri = Uri.parse("https://play.google.com/store/account/subscriptions?sku=${Uri.encode(sku)}&package=${Uri.encode(context.packageName)}")
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                call.resolve()
            } catch (e: Exception) {
                call.reject("Couldn't open Google Play.", "unavailable")
            }
        }
    }

    private fun query(fn: (BillingResult, List<Purchase>) -> Unit) {
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { r, list -> fn(r, list) }
    }

    private fun answer(call: PluginCall, r: BillingResult, key: String, list: List<Purchase>) {
        if (r.responseCode != BillingClient.BillingResponseCode.OK) return fail(call, r, "Google Play didn't answer.")
        val arr = JSArray()
        list.forEach { arr.put(tx(it)) }
        call.resolve(JSObject().put(key, arr))
    }

    /** A purchase in the iOS plugin's transaction shape: the purchase token stands in for the JWS and the ids. */
    private fun tx(p: Purchase) = JSObject().apply {
        put("platform", "google")
        put("jws", p.purchaseToken)
        put("purchaseToken", p.purchaseToken)
        put("transactionId", p.purchaseToken)
        put("originalTransactionId", p.purchaseToken)
        put("productId", p.products.firstOrNull() ?: "")
        put("orderId", p.orderId)
        put("acknowledged", p.isAcknowledged)
        put("autoRenewing", p.isAutoRenewing)
        put("verified", true)
    }

    private fun split(id: String): Pair<String, String>? {
        val i = id.indexOf(':')
        return if (i <= 0 || i == id.length - 1) null else id.substring(0, i) to id.substring(i + 1)
    }

    /** ISO 8601 billing period (P1M, P1Y, P3M, P1W) → unit and count. */
    private fun period(iso: String): Pair<String, Int>? {
        val m = Regex("^P(\\d+)([DWMY])$").find(iso) ?: return null
        val unit = when (m.groupValues[2]) { "D" -> "day"; "W" -> "week"; "M" -> "month"; else -> "year" }
        return unit to m.groupValues[1].toInt()
    }

    private fun planName(name: String, period: Pair<String, Int>?): String = when {
        period == null || period.second != 1 -> name
        period.first == "month" -> "$name Monthly"
        period.first == "year" -> "$name Yearly"
        else -> name
    }

    /** Play's debug messages are for developers; when the device can't buy at all, say so plainly. */
    private fun fail(call: PluginCall, r: BillingResult, fallback: String) {
        val code = codeOf(r.responseCode)
        val msg = if (code == "unavailable") "Google Play isn't available on this device. Subscribing needs Etude installed from the Play Store, with a Google account signed in." else r.debugMessage.ifBlank { fallback }
        call.reject(msg, code)
    }

    private fun codeOf(code: Int) = when (code) {
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE, BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> "unavailable"
        BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> "not_loaded"
        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> "owned"
        BillingClient.BillingResponseCode.NETWORK_ERROR -> "network"
        BillingClient.BillingResponseCode.DEVELOPER_ERROR -> "developer_error"
        else -> "play_$code"
    }
}
