import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { FuelPriceAlertsStack } from '../lib/fuel-price-alerts-stack';
import { WebStack } from '../lib/web-stack';

describe('FuelPriceAlertsStack', () => {
    const app = new App();
    const stack = new FuelPriceAlertsStack(app, 'FuelPriceAlertsStack', {
        env: { account: '123456789012', region: 'ap-southeast-2' },
        siteOrigin: 'https://fuelpricealerts.example.com',
    });
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, { Type: string; DeletionPolicy?: string }>;

    it('keeps the logical IDs of the existing Cognito pool and client so they are never replaced', () => {
        expect(resources.UserPool6BA7E5F2.Type).toBe('AWS::Cognito::UserPool');
        expect(resources.UserPool6BA7E5F2.DeletionPolicy).toBe('Retain');
        expect(resources.UserPooluserappclient0A9D9210.Type).toBe('AWS::Cognito::UserPoolClient');
    });

    it('has nothing billed by the hour', () => {
        const types = new Set(Object.values(resources).map((r) => r.Type));
        for (const type of ['AWS::RDS::DBCluster', 'AWS::EC2::VPC', 'AWS::EC2::NatGateway', 'AWS::SecretsManager::Secret']) {
            expect(types.has(type)).toBe(false);
        }
    });

    it('retains the data bucket and keeps versions for recovery', () => {
        template.hasResource('AWS::S3::Bucket', {
            DeletionPolicy: 'Retain',
            Properties: { VersioningConfiguration: { Status: 'Enabled' } },
        });
    });

    it('runs ingest every two hours, one at a time', () => {
        template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(2 hours)' });
        template.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 1 });
    });
});

describe('WebStack', () => {
    it('serves the site over HTTPS on the custom domain', () => {
        const app = new App();
        const stack = new WebStack(app, 'Web', {
            env: { account: '123456789012', region: 'us-east-1' },
            domainName: 'fuelpricealerts.example.com',
            zoneName: 'example.com',
            hostedZoneId: 'Z123',
        });
        const template = Template.fromStack(stack);
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: { Aliases: ['fuelpricealerts.example.com'] },
        });
        template.resourceCountIs('AWS::Route53::RecordSet', 2);
    });
});
