// Dedicated entry switch: Storybook replaces the Expo Router app instead of living inside its routes.
if (process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === 'true') {
  const { registerRootComponent } = require('expo') as typeof import('expo');
  registerRootComponent(require('./.rnstorybook').default);
} else {
  require('expo-router/entry');
}
