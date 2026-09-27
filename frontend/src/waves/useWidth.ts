import { RefObject, useEffect, useState } from 'react';

/** The rendered width of an element, kept up to date as it resizes. */
export function useWidth(ref: RefObject<HTMLElement>, fallback = 800): number {
    const [width, setWidth] = useState(fallback);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        setWidth(el.clientWidth);
        const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return width;
}
