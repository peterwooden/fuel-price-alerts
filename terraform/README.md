# Terraform

All AWS infrastructure for Fuel Price Alerts. Lambda code is bundled from `../backend`
(`npm run build`) before `terraform plan/apply`. `../build-and-deploy.sh` does the whole thing.

| File | What |
| --- | --- |
| `cognito.tf` | User pool and web client (both `prevent_destroy`: they hold real accounts) |
| `data.tf` | The S3 data bucket that replaced Postgres (versioned, `prevent_destroy`) |
| `lambda.tf` | Ingest (every 2 hours) and the subscriptions API (Function URL) |
| `web.tf` | Site bucket, CloudFront, ACM certificate (us-east-1), DNS records |
| `github.tf` | OIDC trust and the role GitHub Actions deploys with |
| `imports.tf` | One-time adoption of the resources originally created by CDK |

## State

Remote state lives in `s3://fuel-price-alerts-tfstate-032326623602` (versioned, S3-native
locking via `use_lockfile`). The bucket was created once by hand:

```bash
aws s3api create-bucket --bucket fuel-price-alerts-tfstate-032326623602 \
  --region ap-southeast-2 --create-bucket-configuration LocationConstraint=ap-southeast-2
aws s3api put-bucket-versioning --bucket fuel-price-alerts-tfstate-032326623602 \
  --versioning-configuration Status=Enabled
```

## Moving from CDK (September 2026)

Resources that carry identity or data (the user pool and client, both buckets, CloudFront and its
certificate, DNS records, the OIDC provider and deploy role) are **adopted** with the `import`
blocks in `imports.tf`, not recreated. Lambdas, their roles and logs, and the schedule are
recreated with clean names; the Function URL changes, and `build-and-deploy.sh` feeds the new
one into the frontend build.

1. Done: the adopted resources were marked `DeletionPolicy: Retain` in both CloudFormation stacks.
2. `cd backend && npm ci && npm run build && cd ../terraform && terraform init && terraform plan`.
   Expect about 19 imports, 16 creates, ~11 in-place updates (tags, identical policies) and
   **0 destroys or replacements**.
3. `cd .. && ./build-and-deploy.sh`: applies, then rebuilds the frontend against the new API.
4. Delete the old stacks. Retained resources stay; the CDK Lambdas, roles and logs go:
   `aws cloudformation delete-stack --stack-name FuelPriceAlertsStack --region ap-southeast-2` and
   `aws cloudformation delete-stack --stack-name FuelPriceAlertsWeb --region us-east-1`.
5. Delete the CDK bootstrap stacks (`CDKToolkit` in ap-southeast-2 and us-east-1) after emptying
   their `cdk-hnb659fds-assets-*` buckets.
6. Delete `imports.tf`; `terraform plan` should then report no changes.
