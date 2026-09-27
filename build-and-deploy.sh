#!/bin/bash
# Deploy everything: test and bundle the Lambdas, terraform apply, then build and upload the frontend.
# Needs AWS credentials for the account (GitHub Actions uses the OIDC deploy role).
set -euo pipefail
cd "$(dirname "$0")"

echo "Testing and bundling backend..."
(cd backend && npm ci && npm run typecheck && npm test && npm run build)

echo "Applying infrastructure..."
cd terraform
terraform init -input=false
terraform apply -input=false -auto-approve
output() { terraform output -raw "$1"; }
API_URL=$(output api_url)
PUBLIC_API_URL=$(output public_api_url)
SITE_BUCKET=$(output site_bucket)
DISTRIBUTION_ID=$(output distribution_id)
SITE_URL=$(output site_url)
cd ..

echo "Building frontend..."
cd frontend
npm ci
REACT_APP_API_URL="$API_URL" REACT_APP_PUBLIC_API_URL="$PUBLIC_API_URL" npm run build

echo "Uploading frontend..."
# Hashed assets can be cached forever; everything else must revalidate.
aws s3 sync build/static "s3://$SITE_BUCKET/static" --region us-east-1 --delete \
    --cache-control "public,max-age=31536000,immutable"
aws s3 sync build "s3://$SITE_BUCKET" --region us-east-1 --delete --exclude "static/*" \
    --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" > /dev/null

echo "Deployed to $SITE_URL"
