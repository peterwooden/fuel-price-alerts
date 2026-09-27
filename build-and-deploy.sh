#!/bin/bash
# Deploy everything: backend + site infrastructure via CDK, then the frontend build.
# Needs AWS credentials for the account; region-specific bits are set explicitly.
set -euo pipefail
cd "$(dirname "$0")"

echo "Testing and deploying infrastructure..."
cd infrastructure
npm ci
npm test
npx cdk deploy FuelPriceAlertsStack FuelPriceAlertsWeb --require-approval never --outputs-file cdk-outputs.json

output() { node -p "require('./cdk-outputs.json').$1"; }
API_URL=$(output FuelPriceAlertsStack.ApiUrl)
SITE_BUCKET=$(output FuelPriceAlertsWeb.SiteBucketName)
DISTRIBUTION_ID=$(output FuelPriceAlertsWeb.DistributionId)

echo "Building frontend..."
cd ../frontend
npm ci
REACT_APP_API_URL="$API_URL" npm run build

echo "Uploading frontend..."
# Hashed assets can be cached forever; everything else must revalidate.
aws s3 sync build/static "s3://$SITE_BUCKET/static" --region us-east-1 --delete \
    --cache-control "public,max-age=31536000,immutable"
aws s3 sync build "s3://$SITE_BUCKET" --region us-east-1 --delete --exclude "static/*" \
    --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" > /dev/null

echo "Deployed to $(cd ../infrastructure && output FuelPriceAlertsWeb.SiteUrl)"
