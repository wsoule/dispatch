'use client';

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from 'react';

import type { UiLinkComponent, UiLinkProps } from '../types';

// Hosts inject their router's link component once (next/link in the
// planner, a react-router Link elsewhere); components render <Link> and
// never import a framework router themselves.
function PlainLink({ children, ...rest }: UiLinkProps) {
  return <a {...rest}>{children}</a>;
}

const LinkContext = createContext<UiLinkComponent>(PlainLink);

export interface UiLinkProviderProps {
  /** The host's link component (it receives UiLinkProps). */
  link: UiLinkComponent;
  children: ReactNode;
}

export function UiLinkProvider({
  link,
  children,
}: UiLinkProviderProps): ReactNode {
  return <LinkContext.Provider value={link}>{children}</LinkContext.Provider>;
}

/** Renders the host's link component; external URLs get a plain anchor. */
export function Link(props: UiLinkProps) {
  const host = useContext(LinkContext);
  if (/^https?:\/\//.test(props.href)) return <PlainLink {...props} />;
  // createElement, not <Host />: the component comes from context and is
  // stable for the provider's lifetime, so this is not a per-render type.
  return createElement(host, props);
}
