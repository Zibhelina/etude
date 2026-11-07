// The app page's Content-Security-Policy in the serverless builds (etude.study/app and the phone
// apps), added by the build as the first script in <head>. Only the app's own files and scripts
// carrying this page's nonce run, so markup that slips past the sanitizer can't run an inline
// handler, a javascript: URL or an inline <script>.
//
// Card frames here are srcdoc documents, which inherit this policy, so the nonce is fresh on every
// load and card-frame.tsx puts it on the frame's own scripts (frame-local.ts marks where). The
// frame's own policy (src/server/frame.ts) still applies on top. 'unsafe-eval' and blob: stay for
// cards (code graders, plots, worker-backed types); the bundle itself uses neither.
(function () {
  var bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  var nonce = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
  Object.defineProperty(window, "__etudeFrameNonce", { value: nonce });
  var meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = [
    "default-src 'self'",
    "script-src 'self' blob: 'nonce-" + nonce + "' 'unsafe-eval' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: https:",
    // Notes can embed YouTube (privacy-enhanced) and Vimeo players, as on the desktop.
    "frame-src 'self' blob: https://www.youtube-nocookie.com https://player.vimeo.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  document.head.appendChild(meta);
})();
