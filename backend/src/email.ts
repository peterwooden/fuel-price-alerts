import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import type { AlertEmail } from './trends';

export const SENDER = 'fuel-alerts@peterwooden.com';
const SES_MAX_SEND_RATE = 14; // per second, the account's SES quota

const ses = new SESClient({});

export function renderAlertEmail({ alerts }: AlertEmail) {
    const cheapest = [...alerts].sort((a, b) => a.price - b.price)[0];
    const html = `
        <div>Hi, fuel prices are rising.</div>
        <div>Go to ${cheapest.stationName} for the cheapest fuel at ${cheapest.price}c/L.</div>
        <table>
            <tr>
                <th>Station</th>
                <th>Fuel Type</th>
                <th>Current Price</th>
                <th>Past Week Average</th>
                <th>% Change</th>
            </tr>
            ${alerts
                .map(
                    (alert) => `<tr>
                <td>${alert.stationName}</td>
                <td>${alert.fuelType}</td>
                <td>${alert.price.toFixed(1)}</td>
                <td>${alert.timeWeightedPrice.toFixed(1)}</td>
                <td>${formatChange(alert.changePercent)}</td>
            </tr>`,
                )
                .join('')}
        </table>
        <div>
            <img src="${chartUrl(alerts)}"/>
        </div>
    `;
    const text = [
        'Hi, fuel prices are rising.',
        `Go to ${cheapest.stationName} for the cheapest fuel at ${cheapest.price}c/L.`,
        '',
        ...alerts.map(
            (a) =>
                `${a.stationName} (${a.fuelType}): ${a.price.toFixed(1)} now vs ${a.timeWeightedPrice.toFixed(1)} past week average (${formatChange(a.changePercent)})`,
        ),
    ].join('\n');
    return { subject: 'Fuel Price Alert', html, text };
}

const formatChange = (percent: number) => `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;

/** A stepped line chart of each station's past week, rendered by image-charts.com. */
export function chartUrl(alerts: AlertEmail['alerts']) {
    const maxX = new Date(
        Math.max(...alerts.map((alert) => new Date(alert.recentPrices[alert.recentPrices.length - 1].time).getTime())),
    ).toISOString();
    const minX = new Date(new Date(maxX).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const colors = [
        'rgba(255,99,132,0.5)',
        'rgba(255,159,64,0.5)',
        'rgba(255,205,86,0.5)',
        'rgba(75,192,192,0.5)',
        'rgba(54,162,235,0.5)',
    ];
    const chart = {
        type: 'line',
        data: {
            datasets: alerts.map((alert, i) => ({
                label: alert.stationName,
                borderColor: colors[i % colors.length],
                backgroundColor: colors[i % colors.length],
                fill: false,
                data: alert.recentPrices
                    .map(({ time, price }) => ({ x: time < minX ? minX : new Date(time).toISOString(), y: price }))
                    .concat({ x: maxX, y: alert.recentPrices[alert.recentPrices.length - 1].price }),
                steppedLine: true,
            })),
        },
        options: { scales: { xAxes: [{ type: 'time', max: maxX, min: minX }] } },
    };
    return `https://image-charts.com/chart.js/2.8.0?encoding=base64&width=500&height=300&bkg=white&c=${Buffer.from(
        JSON.stringify(chart),
    ).toString('base64')}`;
}

export async function sendEmail(to: string, { subject, html, text }: { subject: string; html: string; text: string }) {
    await ses.send(
        new SendEmailCommand({
            Source: SENDER,
            Destination: { ToAddresses: [to] },
            Message: {
                Subject: { Charset: 'UTF-8', Data: subject },
                Body: { Html: { Charset: 'UTF-8', Data: html }, Text: { Charset: 'UTF-8', Data: text } },
            },
        }),
    );
}

/** Send every alert email, staying under the SES rate limit. Failures are logged, not thrown. */
export async function sendAlertEmails(emails: AlertEmail[]) {
    let sent = 0;
    for (let i = 0; i < emails.length; i += SES_MAX_SEND_RATE) {
        await Promise.all([
            ...emails.slice(i, i + SES_MAX_SEND_RATE).map(async (email) => {
                try {
                    await sendEmail(email.email, renderAlertEmail(email));
                    sent++;
                } catch (e) {
                    console.error(`Failed to email ${email.email}`, e);
                }
            }),
            new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
    }
    return sent;
}
