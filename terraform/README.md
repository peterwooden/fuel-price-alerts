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

## State

Remote state lives in `s3://fuel-price-alerts-tfstate-032326623602` (versioned, S3-native
locking via `use_lockfile`). The bucket was created once by hand:

```bash
aws s3api create-bucket --bucket fuel-price-alerts-tfstate-032326623602 \
  --region ap-southeast-2 --create-bucket-configuration LocationConstraint=ap-southeast-2
aws s3api put-bucket-versioning --bucket fuel-price-alerts-tfstate-032326623602 \
  --versioning-configuration Status=Enabled
```

## Moving from CDK (done 2026-09-27)

Resources that carry identity or data (the user pool and client, both buckets, CloudFront and its
certificate, DNS records, the OIDC provider and deploy role) were **adopted** with Terraform
`import` blocks rather than recreated: 19 imported, 16 created, 0 destroyed. Beforehand they were
marked `DeletionPolicy: Retain` in CloudFormation, so deleting the CDK stacks (and the CDK
bootstrap stacks) left them in place. The Lambdas, roles, logs and schedule were recreated with
clean names, and the frontend was rebuilt against the new Function URL. The import blocks were
removed afterwards; `terraform plan` reports no changes.
