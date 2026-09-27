terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # State bucket is created once by hand (see README); use_lockfile gives S3-native locking.
  backend "s3" {
    bucket       = "fuel-price-alerts-tfstate-032326623602"
    key          = "fuel-price-alerts.tfstate"
    region       = "ap-southeast-2"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "ap-southeast-2"
  default_tags {
    tags = { project = "fuel-price-alerts" }
  }
}

# CloudFront only accepts certificates from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { project = "fuel-price-alerts" }
  }
}
