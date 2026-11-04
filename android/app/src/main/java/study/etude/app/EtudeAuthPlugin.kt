package study.etude.app

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.webkit.CookieManager
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Sign in with ChatGPT for the web app inside the Android shell (src/browser/native-chatgpt.ts),
 * with the same JavaScript shape as the iOS plugin (ios/App/App/EtudeAuthPlugin.swift).
 *
 * OpenAI's flow for open-source clients redirects to an HTTP listener on 127.0.0.1. The app runs
 * that listener itself and shows the sign-in page in a Custom Tab on the same phone, so the redirect
 * lands here. The page can't call auth.openai.com from the WebView (no CORS), so requests to OpenAI
 * go through HttpURLConnection, and the two credential files are encrypted with an AES-GCM key that
 * lives in the Android Keystore; only the ciphertext sits in the app's private storage.
 */
@CapacitorPlugin(name = "EtudeAuth")
class EtudeAuthPlugin : Plugin() {
    companion object {
        /** Only OpenAI's sign-in and API hosts: this is not a general way around the WebView's CORS. */
        val allowedHosts = setOf("auth.openai.com", "api.openai.com")
        /** Only the two ChatGPT credential files. */
        val allowedNames = setOf("chatgpt.json", "chatgpt-host-id")
        private const val KEY_ALIAS = "study.etude.app.chatgpt"
        private const val GCM_IV_BYTES = 12
        private const val GCM_TAG_BITS = 128
        private const val CALLBACK_PAGE =
            "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Etude</title>" +
                "<body style=\"font:17px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:28rem;padding:0 1.5rem;background:#0f0f0f;color:#f2f2f2\">" +
                "<h1 style=\"font-size:1.2rem\">Back to Etude…</h1><p>You can close this page.</p></body>"
    }

    private val io = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    override fun handleOnDestroy() {
        synchronized(lock) { stopListener() }
        io.shutdownNow()
    }

    private fun allowedUrl(raw: String?): Uri? {
        val uri = raw?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return null
        return if (uri.scheme == "https" && uri.host in allowedHosts) uri else null
    }

    // ------------------------------------------------------------------ HTTP

    @PluginMethod
    fun request(call: PluginCall) {
        val uri = allowedUrl(call.getString("url"))
        if (uri == null) {
            call.reject("only https requests to OpenAI's sign-in and API hosts are allowed", "forbidden")
            return
        }
        io.execute {
            var conn: HttpURLConnection? = null
            try {
                conn = URL(uri.toString()).openConnection() as HttpURLConnection
                val timeout = maxOf(1000, (call.getDouble("timeoutMs") ?: 30000.0).toInt())
                conn.connectTimeout = timeout
                conn.readTimeout = timeout
                conn.useCaches = false
                conn.instanceFollowRedirects = false
                conn.requestMethod = call.getString("method") ?: "GET"
                val headers = call.getObject("headers") ?: JSObject()
                for (k in headers.keys()) headers.optString(k, null)?.let { conn.setRequestProperty(k, it) }
                val body = call.getString("body")
                if (body != null) {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = conn.responseCode
                val stream: InputStream? = if (status >= 400) conn.errorStream else runCatching { conn.inputStream }.getOrNull()
                val text = stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
                val out = JSObject()
                for ((k, v) in conn.headerFields) if (k != null) out.put(k.lowercase(), v.joinToString(", "))
                call.resolve(JSObject().put("status", status).put("headers", out).put("body", text))
            } catch (e: SocketTimeoutException) {
                call.reject("the request timed out", "timeout")
            } catch (e: Exception) {
                call.reject(e.message ?: "network error", "network")
            } finally {
                conn?.disconnect()
                forgetOpenAiCookies()
            }
        }
    }

    /**
     * Capacitor installs a process-wide CookieHandler that files every HttpURLConnection cookie in
     * the WebView's jar. The web app never visits OpenAI, so nothing from these hosts belongs there.
     */
    private fun forgetOpenAiCookies() {
        main.post {
            runCatching {
                val jar = CookieManager.getInstance()
                for (host in allowedHosts) {
                    val url = "https://$host"
                    val cookies = jar.getCookie(url) ?: continue
                    for (c in cookies.split(";")) {
                        val name = c.substringBefore("=").trim()
                        if (name.isNotEmpty()) jar.setCookie(url, "$name=; Max-Age=0; Path=/")
                    }
                }
                jar.flush()
            }
        }
    }

    // ------------------------------------------------------------------ Keystore-backed storage

    private fun storeDir(): File = File(context.noBackupFilesDir, "chatgpt").apply { mkdirs() }

    private fun storeFile(name: String) = AtomicFile(File(storeDir(), "$name.enc"))

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Grading can run without the person unlocking anything first, like the iOS Keychain item.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return gen.generateKey()
    }

    @PluginMethod
    fun secureGet(call: PluginCall) {
        val name = call.getString("name")
        if (name == null || name !in allowedNames) {
            call.reject("unknown credential name", "forbidden")
            return
        }
        io.execute {
            val file = storeFile(name)
            if (!file.baseFile.exists()) {
                call.resolve(JSObject().put("value", JSObject.NULL))
                return@execute
            }
            try {
                val blob = file.readFully()
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, blob, 0, GCM_IV_BYTES))
                val plain = cipher.doFinal(blob, GCM_IV_BYTES, blob.size - GCM_IV_BYTES)
                call.resolve(JSObject().put("value", String(plain, Charsets.UTF_8)))
            } catch (e: AEADBadTagException) {
                // Encrypted under a key that no longer exists (the Keystore was reset): it can never be
                // read again, so it's the same as signed out.
                file.delete()
                call.resolve(JSObject().put("value", JSObject.NULL))
            } catch (e: Exception) {
                call.reject("secure storage read failed (${e.javaClass.simpleName})", "keychain")
            }
        }
    }

    @PluginMethod
    fun secureSet(call: PluginCall) {
        val name = call.getString("name")
        val value = call.getString("value")
        if (name == null || name !in allowedNames || value == null) {
            call.reject("unknown credential name", "forbidden")
            return
        }
        io.execute {
            val file = storeFile(name)
            val out = try { file.startWrite() } catch (e: Exception) {
                call.reject("secure storage write failed (${e.javaClass.simpleName})", "keychain")
                return@execute
            }
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key())
                val iv = cipher.iv
                check(iv.size == GCM_IV_BYTES)
                out.write(iv)
                out.write(cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
                file.finishWrite(out)
                call.resolve()
            } catch (e: Exception) {
                file.failWrite(out)
                call.reject("secure storage write failed (${e.javaClass.simpleName})", "keychain")
            }
        }
    }

    // ------------------------------------------------------------------ loopback listener

    private val lock = Any()
    private var server: ServerSocket? = null
    private val hits = ArrayDeque<JSObject>()
    private var waiting: PluginCall? = null
    private var cancelled = false
    /** The Custom Tab is (probably) on top of the app: opened, and no callback has come back yet. */
    private var tabOpen = false
    /** The browser is in front of the app: opened, and the app hasn't come back to the front since. */
    private var browserUp = false

    @PluginMethod
    fun listen(call: PluginCall) {
        val preferred = call.getInt("port") ?: 1455
        io.execute {
            synchronized(lock) {
                stopListener()
                hits.clear()
                cancelled = false
                tabOpen = false
            }
            val loopback = InetAddress.getByName("127.0.0.1")
            for (port in listOf(preferred, 0)) {
                val s = try {
                    ServerSocket().apply {
                        reuseAddress = true
                        bind(InetSocketAddress(loopback, port), 8)
                    }
                } catch (e: Exception) {
                    continue
                }
                synchronized(lock) { server = s }
                io.execute { acceptLoop(s) }
                call.resolve(JSObject().put("port", s.localPort))
                return@execute
            }
            call.reject("couldn't listen on 127.0.0.1", "listen_failed")
        }
    }

    private fun stopListener() {
        runCatching { server?.close() }
        server = null
    }

    private fun acceptLoop(s: ServerSocket) {
        while (!s.isClosed) {
            val conn = try { s.accept() } catch (e: Exception) { break }
            io.execute { handle(conn) }
        }
    }

    private fun handle(conn: Socket) {
        conn.use { sock ->
            try {
                sock.soTimeout = 5000
                // Only the request line matters: "GET /auth/callback?code=…&state=… HTTP/1.1"
                val input = sock.getInputStream()
                val buf = ByteArray(16 * 1024)
                var n = 0
                while (n < buf.size) {
                    val r = input.read(buf, n, buf.size - n)
                    if (r <= 0) break
                    n += r
                    if (String(buf, 0, n, Charsets.ISO_8859_1).contains("\r\n")) break
                }
                val line = String(buf, 0, n, Charsets.ISO_8859_1).substringBefore("\r\n")
                val target = line.split(" ").getOrNull(1) ?: "/"
                val path = target.substringBefore("?")
                val query = if (target.contains("?")) target.substringAfter("?") else ""
                val isCallback = path == "/auth/callback"
                val page = if (isCallback) CALLBACK_PAGE else "not found"
                val bytes = page.toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 ${if (isCallback) "200 OK" else "404 Not Found"}\r\n" +
                    "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n" +
                    "Content-Length: ${bytes.size}\r\n\r\n"
                sock.getOutputStream().apply {
                    write(head.toByteArray(Charsets.ISO_8859_1))
                    write(bytes)
                    flush()
                }
                synchronized(lock) {
                    if (isCallback) tabOpen = false
                    hits.addLast(JSObject().put("path", path).put("query", query))
                    drain()
                }
            } catch (e: Exception) {
                // A half-open or slow connection: nothing to hand on.
            }
        }
    }

    /** Hands the oldest callback to a waiting `next`, or tells it the sign-in was cancelled. Holds `lock`. */
    private fun drain() {
        val call = waiting ?: return
        if (hits.isNotEmpty()) {
            waiting = null
            call.resolve(hits.removeFirst())
            bridge.releaseCall(call)
        } else if (cancelled) {
            waiting = null
            call.reject("ChatGPT sign-in was cancelled", "cancelled")
            bridge.releaseCall(call)
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun next(call: PluginCall) {
        call.setKeepAlive(true)
        synchronized(lock) {
            waiting?.let {
                it.reject("superseded", "cancelled")
                bridge.releaseCall(it)
            }
            waiting = call
            drain()
        }
    }

    // ------------------------------------------------------------------ Custom Tab

    @PluginMethod
    fun open(call: PluginCall) {
        val uri = allowedUrl(call.getString("url"))
        if (uri == null) {
            call.reject("only OpenAI's sign-in page can be opened here", "forbidden")
            return
        }
        main.post {
            val act = activity
            if (act == null) {
                call.reject("no screen to open the sign-in page from", "open_failed")
                return@post
            }
            try {
                val tab = CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .setUrlBarHidingEnabled(false)
                    .build()
                synchronized(lock) {
                    tabOpen = true
                    browserUp = true
                }
                tab.launchUrl(act, uri)
                call.resolve()
            } catch (e: Exception) {
                synchronized(lock) {
                    tabOpen = false
                    browserUp = false
                }
                call.reject("no browser to open the sign-in page in", "open_failed")
            }
        }
    }

    /**
     * The app came back to the front. If the Custom Tab was still waiting for its callback, the
     * person closed it (X or Back): that's a cancel, the same as Cancel on the iOS sheet. The short
     * wait lets a callback that raced the return land first.
     */
    override fun handleOnResume() {
        synchronized(lock) {
            browserUp = false
            if (!tabOpen) return
        }
        main.postDelayed({
            synchronized(lock) {
                if (!tabOpen || hits.isNotEmpty() || server == null) return@postDelayed
                tabOpen = false
                cancelled = true
                stopListener()
                drain()
            }
        }, 1500)
    }

    @PluginMethod
    fun finish(call: PluginCall) {
        val bringBack: Boolean
        synchronized(lock) {
            cancelled = true
            tabOpen = false
            stopListener()
            drain()
            bringBack = browserUp
        }
        main.post {
            // A Custom Tab can't be closed from outside. It runs in the app's task, so bringing the
            // app's own activity forward (singleTask) clears it off the top.
            val act = activity
            if (bringBack && act != null) {
                runCatching {
                    act.startActivity(
                        Intent(act, act.javaClass).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    )
                }
            }
            call.resolve()
        }
    }
}
