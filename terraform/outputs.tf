output "api_url" {
  value = aws_lambda_function_url.subscriptions.function_url
}

output "user_pool_id" {
  value = aws_cognito_user_pool.users.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "data_bucket" {
  value = aws_s3_bucket.data.id
}

output "ingest_function" {
  value = aws_lambda_function.ingest.function_name
}

output "site_bucket" {
  value = aws_s3_bucket.site.id
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_url" {
  value = "https://${local.domain_name}"
}
