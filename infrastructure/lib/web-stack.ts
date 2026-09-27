import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface WebStackProps extends StackProps {
    domainName: string;
    zoneName: string;
    hostedZoneId: string;
}

/**
 * Static site: private S3 bucket behind CloudFront. Lives in us-east-1 because that is
 * where CloudFront requires its certificate. Files are uploaded by build-and-deploy.sh.
 */
export class WebStack extends Stack {
    constructor(scope: Construct, id: string, props: WebStackProps) {
        super(scope, id, props);

        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.zoneName,
        });

        const certificate = new acm.Certificate(this, 'Certificate', {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        const site = new s3.Bucket(this, 'Site', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
        });

        // The SPA handles routing (/account), so unknown paths serve index.html.
        const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
            httpStatus,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: Duration.minutes(5),
        });
        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(site),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            },
            defaultRootObject: 'index.html',
            domainNames: [props.domainName],
            certificate,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            errorResponses: [spaFallback(403), spaFallback(404)],
        });

        const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
        const recordName = props.domainName.slice(0, -(props.zoneName.length + 1));
        new route53.ARecord(this, 'AliasA', { zone, recordName, target });
        new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName, target });

        new CfnOutput(this, 'SiteBucketName', { value: site.bucketName });
        new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
        new CfnOutput(this, 'SiteUrl', { value: `https://${props.domainName}` });
    }
}
