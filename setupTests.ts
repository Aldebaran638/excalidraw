// Server tests use Node's native globals; browser polyfills must stay in jsdom.
if (typeof window !== "undefined") {
  await import("./setupBrowserTests");
}
export {};
