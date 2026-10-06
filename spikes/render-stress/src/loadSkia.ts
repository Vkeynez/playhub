// Native: Skia is linked into the app, nothing to load.
export interface SkiaLoadInfo {
  platform: string;
  source: string;
}

export async function loadSkia(): Promise<SkiaLoadInfo> {
  return { platform: 'native', source: 'linked' };
}
