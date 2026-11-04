// The QuickJS builds the sandbox never asks for (it uses release-sync through getQuickJS()).
// quickjs-emscripten names all four variants, so without this each one's wasm ships with the app.
const fail = () => {
  throw new Error("this QuickJS variant isn't in the browser build");
};
export default { type: "sync", importFFI: fail, importModuleLoader: fail };
