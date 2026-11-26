import { Component, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";

/**
 * A part of the page downloaded when first needed (v0.19.0). React remembers a failed download of a `lazy` part for
 * good, so `reset()` makes a fresh one: the next try downloads again instead of failing at once.
 */
export interface LazyPart<P extends object> {
  readonly Component: LazyExoticComponent<ComponentType<P>>;
  reset(): void;
}

export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): LazyPart<P> {
  const make = () => lazy(() => load().then((C) => ({ default: C })));
  let current = make();
  return {
    get Component() {
      return current;
    },
    reset() {
      current = make();
    },
  };
}

interface Props {
  /** The part; a function is called again after "Try again", so it draws the fresh download. */
  children: ReactNode | (() => ReactNode);
  /** Shown instead when it failed; as a function it gets `retry`, which tries the download again. */
  fallback?: ReactNode | ((retry: () => void) => ReactNode);
  /** The lazy parts inside: made fresh after a failure, so the next try downloads again. */
  parts?: Pick<LazyPart<object>, "reset">[];
  onError?: () => void;
}

/**
 * Around a part of the page that is downloaded when first needed (v0.19.0: VESPER Agent, the admin panel, settings
 * tabs, code colours). If the download fails (offline, or the app was updated since this page was opened and the old
 * file is gone), it shows `fallback` and calls `onError` instead of taking the whole page down.
 */
export class LoadBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    for (const part of this.props.parts ?? []) part.reset();
    this.props.onError?.();
  }

  private readonly retry = () => this.setState({ failed: false });

  override render(): ReactNode {
    const { children, fallback } = this.props;
    if (this.state.failed) return typeof fallback === "function" ? fallback(this.retry) : (fallback ?? null);
    return typeof children === "function" ? children() : children;
  }
}

/** The plain message for a part that couldn't be downloaded. */
export const LOAD_FAILED = "Couldn't load this part of VESPER. Check your connection and try again.";
