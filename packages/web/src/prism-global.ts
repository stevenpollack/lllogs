import { Prism } from "prism-react-renderer";

// Expose prism-react-renderer's bundled Prism as the global so the
// `prismjs/components/prism-bash` side-effect import (in ./prism-bash) attaches
// its grammar to the exact instance <Highlight> tokenizes with. This MUST run
// before that component evaluates — see ./prism-bash for the ordering.
(globalThis as typeof globalThis & { Prism: typeof Prism }).Prism = Prism;
