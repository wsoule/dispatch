import { Button, CodeBlock, cx } from '@dispatch/ui';
import { CodeIcon, WorkflowIcon, WrapTextIcon } from 'lucide-react';
import { createContext, use, useState } from 'react';

import { useHighlightedTokens } from './highlight';
import styles from './MarkdownCodeFence.module.css';
import { MermaidDiagram } from './MermaidDiagram';

/** True while the surrounding message is still streaming in. */
export const MarkdownStreamingContext = createContext(false);

// Display labels for the fence slugs agents write most, shown in CodeBlock's header. A slug
// missing here shows as written; a fence with no language tag shows no label.
const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  javascript: 'JavaScript',
  tsx: 'TSX',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  css: 'CSS',
  scss: 'CSS',
  less: 'CSS',
};

/** The header label for a fence's language slug: the mapped name, else the slug itself. */
function languageLabel(language: string | undefined): string | undefined {
  if (language === undefined || language === '') return undefined;
  return LANGUAGE_LABELS[language] ?? language;
}

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/**
 * A Markdown fence (main v0.51.0's rich fence, on the library CodeBlock): the language
 * label, a wrap toggle and Copy in the header, and the source colored by Shiki once it
 * settles (plain while streaming, so each delta doesn't re-highlight). A ```mermaid fence
 * draws as a diagram with a code/diagram toggle, and falls back to its source, with the
 * reason, when it doesn't parse. The root keeps CodeBlock's `data-slot="code-block"` and
 * carries the raw slug as `data-language`.
 */
export function MarkdownCodeFence({
  code,
  language,
}: {
  code: string;
  language: string | undefined;
}) {
  const streaming = use(MarkdownStreamingContext);
  const isMermaid = language === 'mermaid';
  const [showCode, setShowCode] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [diagramError, setDiagramError] = useState<{
    source: string;
    message: string;
  } | null>(null);
  const failed = diagramError?.source === code ? diagramError.message : null;
  const showDiagram =
    isMermaid &&
    !showCode &&
    !streaming &&
    failed === null &&
    code.trim() !== '';
  const tokens = useHighlightedTokens(
    code,
    language,
    !streaming && !showDiagram
  );

  const actions = (
    <>
      {isMermaid && !streaming && failed === null && (
        <Button
          variant="quiet"
          size="sm"
          aria-label={showCode ? 'Show diagram' : 'Show code'}
          icon={showCode ? <WorkflowIcon {...ICON} /> : <CodeIcon {...ICON} />}
          onClick={() => setShowCode((value) => !value)}
        />
      )}
      {!showDiagram && (
        <Button
          variant="quiet"
          size="sm"
          aria-label={wrap ? 'Stop wrapping' : 'Wrap lines'}
          aria-pressed={wrap}
          icon={<WrapTextIcon {...ICON} />}
          onClick={() => setWrap((value) => !value)}
        />
      )}
    </>
  );

  // No wrapper element: the block (and the reason a diagram failed, above it) stay direct
  // children of the Markdown scope, so markdown.css spaces them and the first and last
  // child rules still reach them.
  return (
    <>
      {failed !== null && (
        <p className={cx('toneText', styles.error)} data-tone="danger">
          Couldn&apos;t draw this diagram: {failed}
        </p>
      )}
      <CodeBlock
        code={code}
        language={languageLabel(language)}
        wrap={wrap}
        actions={actions}
        data-language={language}
        {...(tokens === null ? {} : { tokens })}
      >
        {showDiagram ? (
          <MermaidDiagram
            source={code}
            onError={(message) => setDiagramError({ source: code, message })}
          />
        ) : undefined}
      </CodeBlock>
    </>
  );
}
