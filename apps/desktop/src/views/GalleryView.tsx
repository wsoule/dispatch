import { galleryStories } from './galleryStories';

/**
 * Dev-only review surface for the Beautiful UI primitives (tasks 6-24): a sticky index of
 * every story title on the left, and the stories themselves on the right, each in its own
 * card frame. This view and its nav/command entries only exist in dev builds — see the
 * `import.meta.env.DEV` gates in App.tsx and Sidebar.tsx. `galleryStories` is the single
 * catalog every primitive task appends to, so this component never changes to show new work.
 */
export function GalleryView() {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-center gap-2">
        <h1 className="view-topbar-title">Gallery</h1>
        <span className="text-muted-foreground text-[12px]">
          {galleryStories.length}{' '}
          {galleryStories.length === 1 ? 'primitive' : 'primitives'}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 gap-6">
        <nav
          aria-label="Gallery index"
          className="sticky top-0 flex w-48 shrink-0 flex-col gap-0.5 self-start"
        >
          {galleryStories.map((story) => (
            <a
              key={story.id}
              href={`#gallery-${story.id}`}
              className="text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-control px-2 py-1.5 text-[12px]"
            >
              {story.title}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6 pb-8">
          {galleryStories.map((story) => (
            <section
              key={story.id}
              id={`gallery-${story.id}`}
              className="bg-card rounded-card shadow-card flex flex-col gap-3 p-5"
            >
              <div className="flex flex-col gap-1">
                <h2 className="text-foreground text-[13px] font-semibold">
                  {story.title}
                </h2>
                {story.note !== undefined && (
                  <p className="text-muted-foreground text-[12px]">
                    {story.note}
                  </p>
                )}
              </div>
              <div>{story.render()}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
