import { cx, Dialog } from '@dispatch/ui';
import type { DiagramType } from 'pele/lazy';
import { useEffect, useRef, useState } from 'react';

import styles from './MermaidDiagram.module.css';

type Pele = typeof import('pele/lazy');
type Purify = typeof import('dompurify').default;
type Renderer = { pele: Pele; purify: ReturnType<Purify> };

let rendererLoad: Promise<Renderer | null> | null = null;
// Each diagram type is its own chunk: a chat with one flowchart loads only that parser.
const typeLoads = new Map<DiagramType, Promise<boolean>>();

// CSS that can reach the network or run code. Any backslash is refused outright, since
// CSS escapes (`ur\\l(`, `u\\72l(`) would otherwise hide a url() from these checks.
const ACTIVE_CSS = /\\|@import|image-set\(|expression\(/i;
const ANY_URL = /url\(/gi;
const LOCAL_URL = /url\(\s*(['"]?)#[\w-]+\1\s*\)/gi;

// Allowlist: a value may only reference this SVG's own `#id`s (pele's arrow markers).
function fetchesRemotely(value: string): boolean {
  if (ACTIVE_CSS.test(value)) return true;
  const urls = value.match(ANY_URL)?.length ?? 0;
  const local = value.match(LOCAL_URL)?.length ?? 0;
  return urls !== local;
}

// A DOMPurify instance for diagram SVG. Mermaid `style`/`classDef` lines land in style,
// fill, filter, mask and the like, so any attribute that could fetch is dropped (pele
// draws its own markers by #id).
function diagramPurifier(createPurify: Purify): ReturnType<Purify> {
  const purify = createPurify(window);
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (fetchesRemotely(data.attrValue)) data.keepAttr = false;
  });
  return purify;
}

function loadRenderer(): Promise<Renderer | null> {
  rendererLoad ??= Promise.all([import('pele/lazy'), import('dompurify')]).then(
    ([pele, dompurify]) => ({
      pele,
      purify: diagramPurifier(dompurify.default),
    }),
    () => null
  );
  return rendererLoad;
}

function loadType(pele: Pele, type: DiagramType): Promise<boolean> {
  const cached = typeLoads.get(type);
  if (cached !== undefined) return cached;
  const load = pele.load(type).catch(() => false);
  typeLoads.set(type, load);
  return load;
}

// Agent output is untrusted: pele escapes labels and links and images are off, and this
// strips anything left that could navigate, run script or fetch.
const SANITIZE_OPTIONS = {
  FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'],
  FORBID_TAGS: ['a', 'image', 'foreignObject', 'style', 'script'],
  USE_PROFILES: { svg: true, svgFilters: true },
};

function sanitizer(purify: ReturnType<Purify>) {
  return (svg: string): Node =>
    purify.sanitize(svg, { ...SANITIZE_OPTIONS, RETURN_DOM_FRAGMENT: true });
}

/**
 * A ```mermaid fence drawn as a themed SVG by pele (Obsidian's Mermaid renderer), which
 * reads its colors from `--pele-*` (markdown.css maps them to Gr8r tokens) so it follows
 * light and dark. Clicking opens it larger in the library Dialog. A parse error or a failed
 * load reports through `onError`, and the caller falls back to the fence's source.
 */
export function MermaidDiagram({
  source,
  onError,
}: {
  source: string;
  onError: (message: string) => void;
}) {
  const mountRef = useRef<HTMLSpanElement>(null);
  const [rendered, setRendered] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Held in a ref so a new callback identity doesn't remount the diagram.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const element = mountRef.current;
    if (!element) return;
    let destroy: (() => void) | undefined;
    let live = true;
    const fail = (message: string) => {
      if (live) onErrorRef.current(message);
    };
    void (async () => {
      const renderer = await loadRenderer();
      if (!live) return;
      if (!renderer) return fail('The diagram renderer failed to load.');
      let type: DiagramType | null = null;
      try {
        type = renderer.pele.detectType(source);
      } catch {
        type = null;
      }
      if (!type) return fail('Unknown diagram type.');
      if (!(await loadType(renderer.pele, type)) || !live) {
        return live ? fail('The diagram renderer failed to load.') : undefined;
      }
      const mounted = renderer.pele.mount(element, source, {
        links: false,
        images: false,
        zoom: false,
        autoDirection: false,
        sanitize: sanitizer(renderer.purify),
        onRender: () => {
          if (live) setRendered(true);
        },
        onError: (error) =>
          fail(
            error instanceof Error
              ? error.message
              : 'The diagram could not be rendered.'
          ),
      });
      destroy = () => mounted.destroy();
    })();
    return () => {
      live = false;
      destroy?.();
    };
  }, [source]);

  return (
    <>
      <button
        type="button"
        aria-label="Expand diagram"
        data-slot="mermaid-diagram"
        data-rendered={rendered || undefined}
        className={styles.diagram}
        onClick={() => {
          const svg = mountRef.current?.innerHTML;
          if (!svg) return;
          // Sanitized again rather than trusted: re-parsing serialized markup can differ.
          void loadRenderer().then((renderer) => {
            if (renderer)
              setExpanded(renderer.purify.sanitize(svg, SANITIZE_OPTIONS));
          });
        }}
      >
        <span ref={mountRef} className={cx('pele', styles.mount)} />
      </button>
      <Dialog
        open={expanded !== null}
        onClose={() => setExpanded(null)}
        title="Diagram"
        size="lg"
      >
        {expanded !== null && (
          <div
            className={cx('pele', styles.expanded)}
            dangerouslySetInnerHTML={{ __html: expanded }}
          />
        )}
      </Dialog>
    </>
  );
}
