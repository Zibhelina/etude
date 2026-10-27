// `node:module` in the browser build: the server only uses createRequire to find vendor files in
// node_modules, which the browser build ships as static files instead.
export const createRequire = () => {
  const r = () => {
    throw new Error("require isn't available in the browser build");
  };
  r.resolve = r;
  return r;
};
export default { createRequire };
