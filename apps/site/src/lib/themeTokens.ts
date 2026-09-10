// tokens.css declares the palette twice: light on `:root`, dark under
// `@media (prefers-color-scheme: dark)`. The site's theme toggle sets
// `data-theme` on <html>, so both blocks also need to be reachable by
// attribute. Rather than restating the palette here, this splits the
// stylesheet into its two blocks and re-emits each under every condition
// it applies to. Comments are dropped on the way so the inlined CSS stays
// small.
export function themeAwareTokens(css: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const [light, dark, ...rest] = stripped.split(
    '@media (prefers-color-scheme: dark)'
  );
  if (light === undefined || dark === undefined || rest.length > 0) {
    throw new Error(
      'tokens.css must contain exactly one prefers-color-scheme: dark block'
    );
  }
  const lightDecls = innerBlock(light);
  // The dark block wraps `:root { ... }` in the media query, so unwrap twice.
  const darkDecls = innerBlock(innerBlock(dark));
  for (const decls of [lightDecls, darkDecls]) {
    if (!decls.includes('--surface-page:')) {
      throw new Error('tokens.css block is missing --surface-page');
    }
  }
  return [
    `:root{${lightDecls}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${darkDecls}}}`,
    `:root[data-theme="dark"]{${darkDecls}}`,
  ].join('\n');
}

// Returns whatever sits between a block's first `{` and last `}`, with runs
// of whitespace collapsed.
function innerBlock(block: string): string {
  const open = block.indexOf('{');
  const close = block.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) {
    throw new Error('tokens.css block has no braces to unwrap');
  }
  return block
    .slice(open + 1, close)
    .replace(/\s+/g, ' ')
    .trim();
}
