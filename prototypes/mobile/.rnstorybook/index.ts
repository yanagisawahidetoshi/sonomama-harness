import { view } from './storybook.requires';

// No storage adapter: AsyncStorage is intentionally not installed in the prototype.
const StorybookUIRoot = view.getStorybookUI({});

export default StorybookUIRoot;
