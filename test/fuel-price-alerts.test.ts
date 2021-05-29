import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as FuelPriceAlerts from '../lib/fuel-price-alerts-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new FuelPriceAlerts.FuelPriceAlertsStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
