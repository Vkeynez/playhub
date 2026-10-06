// Native: Skia is linked into the app binary; there is nothing to load.
export function loadSkiaPlatform(): Promise<void> {
  return Promise.resolve();
}
