import { GlobalRegistrator } from '@happy-dom/global-registrator';

// A DOM for @testing-library/react. CSS modules resolve to plain objects
// under Bun, so class names are still testable.
GlobalRegistrator.register();
