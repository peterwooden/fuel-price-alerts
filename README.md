# Fuel Price Alerts

Emails you when fuel at your chosen NSW stations rises more than 5% above its average over
the past week. Live at https://fuelpricealerts.peterwooden.com.

- `frontend/`: React app (station picker, Cognito sign-in).
- `infrastructure/`: CDK app, Lambdas and tests. See its README.
- `docs/cost-reduction.md`: why this runs on S3 and Lambda instead of Aurora
  (from about $73/month to about $0.02/month).
- `docs/migration-runbook.md`: the Aurora-to-S3 cutover steps.

Deploy with `./build-and-deploy.sh`. GitHub Actions runs the tests on every push and deploys from `main`.
