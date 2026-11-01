import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  WorkflowIcon,
  WrapTextIcon,
} from 'lucide-react';
import { createContext, use, useEffect, useRef, useState } from 'react';

import { useHighlightedHtml } from './highlight';
import { MermaidDiagram } from './MermaidDiagram';
import { IconButton } from '@/ui/ai/icon-button';

/** True while the surrounding message is still streaming in. */
export const MarkdownStreamingContext = createContext(false);

const COPIED_RESET_MS = 1500;

/**
 * T3 Code's fenced code block: a soft card with a mono language label, a wrap toggle and
 * a copy button, and the source colored by Shiki once it settles (plain while streaming,
 * so each delta doesn't re-highlight). A ```mermaid fence draws as a diagram with a
 * code/diagram toggle, and falls back to its source when it doesn't parse.
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
  const html = useHighlightedHtml(code, language, !streaming && !showDiagram);

  return (
    <div
      data-slot="code-fence"
      data-language={language}
      className="border-border/70 bg-secondary dark:bg-input/32 my-[0.65em] w-full overflow-hidden rounded-lg border leading-snug dark:border-transparent"
    >
      <div className="flex items-center justify-between gap-2 pt-1.5 pr-1.5 pl-3">
        <span className="text-foreground/72 min-w-0 truncate font-mono text-[11px]">
          {language ?? 'text'}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {isMermaid && !streaming && failed === null && (
            <IconButton
              label={showCode ? 'Show diagram' : 'Show code'}
              onClick={() => setShowCode((value) => !value)}
              className="size-6"
            >
              {showCode ? (
                <WorkflowIcon aria-hidden className="size-3.5" />
              ) : (
                <CodeIcon aria-hidden className="size-3.5" />
              )}
            </IconButton>
          )}
          {!showDiagram && (
            <IconButton
              label={wrap ? 'Stop wrapping' : 'Wrap lines'}
              onClick={() => setWrap((value) => !value)}
              aria-pressed={wrap}
              active={wrap}
              className="size-6"
            >
              <WrapTextIcon aria-hidden className="size-3.5" />
            </IconButton>
          )}
          <CopyCodeButton code={code} />
        </span>
      </div>
      {showDiagram ? (
        <MermaidDiagram
          source={code}
          onError={(message) => setDiagramError({ source: code, message })}
        />
      ) : (
        <div
          data-wrap={wrap || undefined}
          className="dispatch-md-code overflow-x-auto px-3 pt-1 pb-3 font-mono text-[12px]"
        >
          {failed !== null && (
            <p className="text-destructive mb-1.5 font-sans text-[11px]">
              Couldn&apos;t draw this diagram: {failed}
            </p>
          )}
          {html === null ? (
            <pre>
              <code>{code}</code>
            </pre>
          ) : (
            // Shiki escapes the source; its output is spans with color variables.
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      )}
    </div>
  );
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );
  return (
    <IconButton
      label={copied ? 'Copied' : 'Copy code'}
      onClick={() => {
        void navigator.clipboard?.writeText(code).catch(() => undefined);
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(
          () => setCopied(false),
          COPIED_RESET_MS
        );
      }}
      className="size-6"
    >
      {copied ? (
        <CheckIcon aria-hidden className="text-green size-3.5" />
      ) : (
        <CopyIcon aria-hidden className="size-3.5" />
      )}
    </IconButton>
  );
}
