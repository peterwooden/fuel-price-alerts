#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { FuelPriceAlertsStack } from '../lib/fuel-price-alerts-stack';
import { WebStack } from '../lib/web-stack';

const app = new App();
const zoneName: string = app.node.getContext('domain');
const domainName = `${app.node.getContext('subdomain')}.${zoneName}`;
const account = process.env.CDK_DEFAULT_ACCOUNT;

new FuelPriceAlertsStack(app, 'FuelPriceAlertsStack', {
    env: { account, region: 'ap-southeast-2' },
    siteOrigin: `https://${domainName}`,
});

new WebStack(app, 'FuelPriceAlertsWeb', {
    env: { account, region: 'us-east-1' },
    domainName,
    zoneName,
    hostedZoneId: app.node.getContext('hostedZoneId'),
});
