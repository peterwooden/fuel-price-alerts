import React from 'react';
import { compass, FAR_KM, NEAR_KM, Spread } from './analysis';
import { formatHours, HOUR } from './time';

const MIN_MOVED = 10;
const gap = (hours: number | null) => (hours === null ? 'n/a' : formatHours(hours));

function headline(s: Spread): { title: string; detail: string } {
    const { nearOtherBrand, farOtherBrand, farSameBrand } = s.gaps;
    const comparison =
        `Stations of the same brand ${FAR_KM}+ km apart typically moved ${gap(farSameBrand)} apart; ` +
        `neighbours of different brands under ${NEAR_KM} km apart, ${gap(nearOtherBrand)}; ` +
        `different brands ${FAR_KM}+ km apart, ${gap(farOtherBrand)}.`;
    if (s.moved < MIN_MOVED) {
        return { title: 'Too few stations moved to see a pattern.', detail: 'Pick a busier day on the timeline, or switch between rises and cuts.' };
    }
    switch (s.verdict) {
        case 'wave':
            return {
                title: `This moved like a wave, travelling ${compass(s.front!.bearing)} at about ${Math.round(s.front!.kmPerHour)} km/h.`,
                detail: `A single straight front explains ${Math.round(s.front!.r2 * 100)}% of when stations moved. ${comparison}`,
            };
        case 'local':
            return { title: 'This spread through local clusters.', detail: `Neighbours moved closer together in time than distant stations. ${comparison}` };
        case 'brand':
            return { title: 'This spread by brand, not by place.', detail: comparison };
        case 'brand-weak':
            return { title: 'No wave across the city: brand mattered more than place.', detail: comparison };
        default:
            return { title: 'No clear geographic or brand pattern.', detail: comparison };
    }
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
    return (
        <div className="waves-tile">
            <div className="waves-tile-label">{label}</div>
            <div className="waves-tile-value">{value}</div>
            <div className="waves-tile-note">{note}</div>
        </div>
    );
}

export function Verdict({ spread: s, verb }: { spread: Spread; verb: string }) {
    const { title, detail } = headline(s);
    const since = (t: number | null) => (t === null || s.first === null ? 'n/a' : formatHours((t - s.first) / HOUR));
    return (
        <section aria-live="polite">
            <h2 className="waves-headline">{title}</h2>
            <p className="waves-lede">{detail}</p>
            <div className="waves-tiles">
                <Tile
                    label={`Stations that ${verb}`}
                    value={`${s.moved} of ${s.total}`}
                    note={s.moved ? `half within ${since(s.half)} of the first, 90% within ${since(s.ninety)}` : 'none in this window'}
                />
                <Tile label={`Same brand, ${FAR_KM}+ km apart`} value={gap(s.gaps.farSameBrand)} note="typical time between them moving" />
                <Tile label={`Other brands, under ${NEAR_KM} km`} value={gap(s.gaps.nearOtherBrand)} note="neighbours: small if it spreads locally" />
                <Tile label={`Other brands, ${FAR_KM}+ km apart`} value={gap(s.gaps.farOtherBrand)} note="the baseline to compare with" />
                <Tile
                    label="Fit to one wave front"
                    value={s.front ? `${Math.round(s.front.r2 * 100)}%` : 'n/a'}
                    note={s.front && s.front.r2 >= 0.3 ? `heading ${compass(s.front.bearing)}` : 'of the timing; a real wave scores high'}
                />
            </div>
        </section>
    );
}
