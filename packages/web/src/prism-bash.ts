/**
 * Register prismjs's upstream, tested Bash grammar onto prism-react-renderer's
 * bundled Prism instance — replacing the previous hand-rolled grammar.
 *
 * prism-react-renderer ships a Prism subset WITHOUT a shell grammar and reads
 * grammars from `Prism.languages`. The documented extension point is to expose
 * that Prism as the global so a `prismjs/components/*` file attaches its grammar
 * to the same instance <Highlight> uses.
 *
 * Ordering matters: the global must be set BEFORE the component evaluates. ES
 * `import` statements are hoisted above any in-module assignment, so the
 * assignment lives in ./prism-global and is imported on the line above — sibling
 * side-effect imports evaluate in source order, so the global is set first.
 */
import "./prism-global";
import "prismjs/components/prism-bash";
