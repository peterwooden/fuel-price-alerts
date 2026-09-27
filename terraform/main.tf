locals {
  name          = "fuel-price-alerts"
  domain_name   = "fuelpricealerts.peterwooden.com"
  site_origin   = "https://${local.domain_name}"
  zone_id       = "Z05956822F62HQUM60NM9" # peterwooden.com, shared with the personal site
  config_prefix = "/fuel-price-alerts/"   # SSM parameters: nsw-api-key, nsw-api-basic-auth, error-email
  ses_identity  = "peterwooden.com"
  github_repo   = "peterwooden/fuel-price-alerts"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
