// Metro for a pnpm monorepo. Expo's defaults find the workspace root and its
// packages; the one thing added here is a single React. @dispatch/client
// depends on the catalog's react, while Expo pins its own, and two copies of
// React in one bundle break every hook. Every `react` import resolves from
// this app.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const fromApp = path.join(__dirname, 'package.json');

/** @param {string} moduleName */
const isReact = (moduleName) =>
  moduleName === 'react' || moduleName.startsWith('react/');

/** @type {NonNullable<typeof config.resolver.resolveRequest>} */
const resolveRequest = (context, moduleName, platform) => {
  if (isReact(moduleName)) {
    return context.resolveRequest(
      { ...context, originModulePath: fromApp },
      moduleName,
      platform
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};
config.resolver.resolveRequest = resolveRequest;

module.exports = config;
