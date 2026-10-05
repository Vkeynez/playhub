// Package boundaries from ARCHITECTURE §2. Run with `pnpm lint`.
const PURE = '^packages/(game-sdk/src/(core|engine)|protocol/src|sync/src|games/[^/]+/src/(logic|bot))/';
const UI = '^packages/(ui|games/[^/]+/src/(ui|tile))/|^packages/game-sdk/src/client/';
const PLATFORM_PKGS =
  'node_modules/(react|react-dom|react-native|react-native-[^/]+|expo|expo-[^/]+|@expo/[^/]+|@shopify/react-native-skia)/';

module.exports = {
  forbidden: [
    {
      name: 'pure-no-platform-or-ui',
      comment: 'Pure packages run on the server, offline client and in tests: no UI or platform code.',
      severity: 'error',
      from: { path: PURE },
      to: { path: [UI, PLATFORM_PKGS] },
    },
    {
      name: 'pure-no-node-builtins',
      severity: 'error',
      from: { path: PURE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'server-no-ui',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: UI },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
