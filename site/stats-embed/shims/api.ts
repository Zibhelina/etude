// The website has no server: the panels are given their data from the snapshots, so nothing here
// is ever called. It only stands in for web/src/lib/api so the Stats page module can be imported.
export class ApiError extends Error {
  status = 0;
}

const none = async () => {
  throw new ApiError("no server on the website");
};

export const api = { stats: none, decks: none };
