import React, { MutableRefObject, ReactNode, useEffect, useRef, useState } from 'react';
import { useWidth } from './useWidth';
import { Map, PigeonProps } from 'pigeon-maps';
import { ink } from './colors';

export interface MapPoint {
    lat: number;
    lng: number;
    /** Fill colour, or null for a hollow ring (stations that didn't move). */
    fill: string | null;
    /** Draw order: higher is drawn later, on top. */
    z: number;
    /** An extra ring, e.g. a station that has just changed its price. */
    pulse?: boolean;
}

type HitTest = (x: number, y: number) => number | null;

interface LayerProps extends PigeonProps {
    points: MapPoint[];
    highlight: number | null;
    arrow: { bearing: number } | null;
    hitTest: MutableRefObject<HitTest | null>;
}

/** All stations drawn on one canvas: hundreds of markers as DOM nodes are too slow to animate. */
function StationLayer({ points, highlight, arrow, hitTest, latLngToPixel, mapState }: LayerProps) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const width = mapState?.width ?? 0;
    const height = mapState?.height ?? 0;
    const zoom = mapState?.zoom ?? 10;

    useEffect(() => {
        const el = canvas.current;
        if (!el || !latLngToPixel) return;
        const dpr = window.devicePixelRatio || 1;
        el.width = width * dpr;
        el.height = height * dpr;
        const ctx = el.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const r = zoom >= 12 ? 6 : zoom >= 11 ? 5 : 4;
        const xy = points.map((p) => latLngToPixel([p.lat, p.lng]));
        const order = points.map((_, i) => i).sort((a, b) => points[a].z - points[b].z);
        for (const i of order) {
            const [x, y] = xy[i];
            const { fill, pulse } = points[i];
            if (pulse) {
                ctx.beginPath();
                ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
                ctx.strokeStyle = fill ?? ink.muted;
                ctx.globalAlpha = 0.45;
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            ctx.beginPath();
            ctx.arc(x, y, r, 0, 2 * Math.PI);
            // 2px surface ring keeps overlapping dots apart.
            ctx.lineWidth = 2;
            ctx.strokeStyle = ink.surface;
            ctx.fillStyle = fill ?? ink.surface;
            ctx.fill();
            ctx.stroke();
            if (!fill) {
                ctx.beginPath();
                ctx.arc(x, y, r - 1, 0, 2 * Math.PI);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = ink.muted;
                ctx.stroke();
            }
        }
        if (highlight !== null && xy[highlight]) {
            const [x, y] = xy[highlight];
            ctx.beginPath();
            ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
            ctx.lineWidth = 2;
            ctx.strokeStyle = ink.primary;
            ctx.stroke();
        }
        if (arrow) drawArrow(ctx, width, height, arrow.bearing);

        hitTest.current = (px, py) => {
            let best: number | null = null;
            let bestD = 12 * 12;
            xy.forEach(([x, y], i) => {
                const d = (x - px) ** 2 + (y - py) ** 2;
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            });
            return best;
        };
    });

    return <canvas ref={canvas} style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }} />;
}

/** The direction a wave front travels, as an arrow through the middle of the map. */
function drawArrow(ctx: CanvasRenderingContext2D, width: number, height: number, bearing: number) {
    const a = (bearing * Math.PI) / 180;
    const [dx, dy] = [Math.sin(a), -Math.cos(a)];
    const len = Math.min(width, height) * 0.3;
    const [cx, cy] = [width / 2, height / 2];
    const [x0, y0, x1, y1] = [cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len];
    ctx.strokeStyle = ink.primary;
    ctx.fillStyle = ink.primary;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - dx * 12, y1 - dy * 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - dx * 16 - dy * 9, y1 - dy * 16 + dx * 9);
    ctx.lineTo(x1 - dx * 16 + dy * 9, y1 - dy * 16 - dx * 9);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
}

interface Props {
    points: MapPoint[];
    highlight: number | null;
    onHover: (index: number | null) => void;
    arrow: { bearing: number } | null;
    /** Overlays drawn over the map (legend, clock). */
    children?: ReactNode;
    tooltip?: ReactNode;
}

const SYDNEY_CENTER: [number, number] = [-33.84, 151.0];

export function StationMap({ points, highlight, onHover, arrow, children, tooltip }: Props) {
    const hitTest = useRef<HitTest | null>(null);
    const wrapper = useRef<HTMLDivElement>(null);
    const width = useWidth(wrapper);
    const narrow = width < 560;
    const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
    const [center, setCenter] = useState(SYDNEY_CENTER);
    const [zoom, setZoom] = useState(10);
    // Fit all of Sydney on small screens.
    useEffect(() => setZoom(narrow ? 9 : 10), [narrow]);

    const pick = (clientX: number, clientY: number) => {
        const box = wrapper.current!.getBoundingClientRect();
        const x = clientX - box.left;
        const y = clientY - box.top;
        const hit = hitTest.current?.(x, y) ?? null;
        setPointer(hit === null ? null : { x, y });
        onHover(hit);
    };

    return (
        <div
            ref={wrapper}
            className="waves-map relative"
            onMouseMove={(e) => pick(e.clientX, e.clientY)}
            onMouseLeave={() => {
                setPointer(null);
                onHover(null);
            }}
        >
            <Map
                height={narrow ? 400 : 520}
                center={center}
                zoom={zoom}
                minZoom={8}
                maxZoom={15}
                metaWheelZoom
                onBoundsChanged={({ center, zoom }) => {
                    setCenter(center);
                    setZoom(zoom);
                }}
                onClick={({ event }) => pick(event.clientX, event.clientY)}
            >
                <StationLayer points={points} highlight={highlight} arrow={arrow} hitTest={hitTest} />
            </Map>
            {children}
            {pointer && tooltip && (
                <div
                    className="waves-tooltip"
                    style={{
                        left: Math.min(pointer.x + 14, (wrapper.current?.clientWidth ?? 400) - 230),
                        top: Math.max(8, pointer.y - 60),
                    }}
                >
                    {tooltip}
                </div>
            )}
        </div>
    );
}
