import { arrivals, breadth, detectMoves, fitFront, indexAt, priceAt, spread, turningPoints } from './analysis';
import type { Series, Station } from './data';
import { decodePrices } from './data';
import { changeColor, UNCHANGED } from './colors';
import { formatDayTime, formatHours, HOUR, startOfSydneyDay, sydneyDays } from './time';

const T0 = Date.parse('2026-08-02T14:00:00Z'); // Mon 3 Aug, midnight in Sydney
const at = (hours: number) => T0 + hours * HOUR;
const series = (station: number, points: [number, number][]): Series => ({
    station,
    times: points.map(([h]) => at(h)),
    prices: points.map(([, p]) => p),
});

// Stations on a 10 x 10 grid 2.5 km apart, brands assigned round-robin so neighbours differ.
const KM = 2.5;
const BRANDS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const grid: Station[] = [];
for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
        grid.push({
            code: `${i}-${j}`,
            name: `Station ${i}-${j}`,
            brand: BRANDS[(i * 10 + j) % 4],
            lat: -33.87 + (i * KM) / 111.2,
            lng: 151.0 + (j * KM) / 92.3,
        });
    }
}
/** Every grid station raises its price by 4c at the given hour. */
const raiseAt = (hourOf: (s: Station, index: number) => number) =>
    grid.map((s, i) => series(i, [[-10, 180], [hourOf(s, i), 184]]));

describe('priceAt', () => {
    const s = series(0, [[1, 180], [2, 182]]);
    it('is the latest price at or before t', () => {
        expect(priceAt(s, at(0.5))).toBeUndefined();
        expect(priceAt(s, at(1))).toBe(180);
        expect(priceAt(s, at(1.9))).toBe(180);
        expect(priceAt(s, at(5))).toBe(182);
        expect(indexAt([], at(1))).toBe(-1);
    });
});

describe('arrivals', () => {
    const win = { start: at(0), end: at(24) };
    it('records when each station had moved by 2c from its price at the start of the window', () => {
        const [steps, jump, none, cut] = arrivals(
            [
                series(0, [[-5, 180], [6, 181], [7, 182]]), // two 1c steps add up
                series(1, [[-5, 180], [8, 185], [30, 190]]),
                series(2, [[-5, 180], [9, 181]]),
                series(3, [[-5, 180], [9, 175]]),
            ],
            win,
            1,
        );
        expect(steps).toMatchObject({ base: 180, at: at(7), change: 2 });
        expect(jump).toMatchObject({ at: at(8), change: 5 }); // the 190 is after the window
        expect(none).toMatchObject({ at: null, change: 1 });
        expect(cut).toMatchObject({ at: null, change: -5 });
        expect(arrivals([series(3, [[-5, 180], [9, 175]])], win, -1)[0].at).toBe(at(9));
    });

    it('leaves out stations with no price yet at the start', () => {
        expect(arrivals([series(0, [[3, 180], [6, 185]])], win, 1)).toEqual([]);
    });
});

describe('spread', () => {
    it('spots a wave: arrival time rising steadily from west to east', () => {
        // Moves at 10 km/h eastward, whatever the brand.
        const all = arrivals(raiseAt((s) => 6 + (((s.lng - 151.0) * 92.3) / 10)), { start: at(0), end: at(24) }, 1);
        const result = spread(all, grid);
        expect(result.verdict).toBe('wave');
        expect(result.front!.r2).toBeGreaterThan(0.99);
        expect(result.front!.bearing).toBeCloseTo(90, 0);
        expect(result.front!.kmPerHour).toBeCloseTo(10, 0);
    });

    it('spots moves set by brand: each brand moves together wherever its stations are', () => {
        const all = arrivals(raiseAt((s, i) => 6 + BRANDS.indexOf(s.brand) * 2 + (i % 3) * 0.05), { start: at(0), end: at(24) }, 1);
        const result = spread(all, grid);
        expect(result.verdict).toBe('brand');
        expect(result.gaps.farSameBrand!).toBeLessThan(0.2);
        expect(result.front!.r2).toBeLessThan(0.3);
        expect(result.brands.find((b) => b.brand === 'Alpha')).toMatchObject({ total: 25, moved: 25, median: at(6.05) });
    });

    it('spots local clusters: neighbours move together, whatever their brand', () => {
        // Each quadrant moves at its own time, arranged so no single front fits.
        const hour = (s: Station) => {
            const north = s.lat > -33.87 + (4.5 * KM) / 111.2;
            const east = s.lng > 151.0 + (4.5 * KM) / 92.3;
            return north ? (east ? 6 : 12) : east ? 13 : 7;
        };
        const result = spread(arrivals(raiseAt(hour), { start: at(0), end: at(24) }, 1), grid);
        expect(result.front!.r2).toBeLessThan(0.3);
        expect(result.verdict).toBe('local');
    });

    it('counts who moved and when half of them had', () => {
        const all = arrivals(raiseAt((s, i) => (i < 50 ? 6 : 30)), { start: at(0), end: at(24) }, 1);
        expect(spread(all, grid)).toMatchObject({ total: 100, moved: 50, first: at(6), half: at(6) });
    });
});

describe('fitFront', () => {
    it('needs enough stations', () => {
        expect(fitFront([{ x: 0, y: 0, t: 0 }])).toBeNull();
    });
});

describe('turningPoints', () => {
    it('turns only once the value comes back by the threshold', () => {
        //            0    1    2    3    4    5    6    7    8
        const v = [200, 201, 199, 196, 197, 195, 199, 205, 204];
        expect(turningPoints(v, 3)).toEqual([1, 5, 7]);
        expect(turningPoints([200, 201, 202], 3)).toEqual([]);
    });
});

describe('detectMoves', () => {
    it('finds a morning when every station raised its price', () => {
        const all = grid.map((s, i) => series(i, [[-72, 180], [30 + (i % 5) * 0.2, 185]])); // Tue 4 Aug ~6am
        const moves = detectMoves(all, at(-72), at(96));
        const round = moves.find((m) => m.kind === 'round' && m.direction === 1)!;
        expect(round).toMatchObject({ start: at(24), end: at(48), breadth: 1, label: 'Tue 4 Aug: 100% of stations raised prices' });
        expect(breadth(all, round, -1)).toBe(0);
    });
});

describe('Sydney time', () => {
    it('finds midnight in Sydney across daylight saving changes', () => {
        expect(startOfSydneyDay(at(7.5))).toBe(T0);
        expect(formatDayTime(at(6.25))).toBe('Mon 3 Aug, 6:15am');
        const days = sydneyDays(Date.parse('2026-10-02T14:00:00Z'), Date.parse('2026-10-05T14:00:00Z'));
        expect(days.map((d) => new Date(d).toISOString())).toEqual([
            '2026-10-02T14:00:00.000Z',
            '2026-10-03T14:00:00.000Z',
            '2026-10-04T13:00:00.000Z', // clocks went forward on Sunday 4 October
            '2026-10-05T13:00:00.000Z',
        ]);
    });

    it('formats durations in comparable units', () => {
        expect([0.4, 2.44, 45, 50, 100].map(formatHours)).toEqual(['24 min', '2.4 h', '45 h', '50 h', '4.2 d']);
    });
});

describe('decodePrices', () => {
    it('turns minutes and tenths of a cent into times and c/L, keeping the later of two updates in a minute', () => {
        const data = decodePrices({
            version: 1,
            generatedAt: '2026-08-03T00:00:00.000Z',
            from: '2026-08-02T14:00:00.000Z',
            to: '2026-08-03T14:00:00.000Z',
            stations: [{ code: '1', name: 'One', brand: 'Alpha', lat: -33.9, lng: 151 }],
            series: { U91: [[0, [-60, 1799, 360, 1819, 360, 1829]]] },
        });
        expect(data.fuels.U91[0]).toEqual({ station: 0, times: [at(-1), at(6)], prices: [179.9, 182.9] });
        expect(data.from).toBe(T0);
    });
});

describe('changeColor', () => {
    it('is neutral for no change or an unknown one, and saturates at the maximum', () => {
        expect(changeColor(0, 5)).toBe(UNCHANGED);
        expect(changeColor(NaN, 5)).toBe(UNCHANGED);
        expect(changeColor(50, 5)).toBe(changeColor(5, 5));
        expect(changeColor(-2, 5)).not.toBe(changeColor(2, 5));
    });
});
