terraform {
  backend "s3" {
    bucket       = "xid-prod-terraform"
    key          = "lightdash-ecr"
    region       = "us-west-2"
    profile      = "xid-prod"
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "aws_profile" {
  description = "AWS profile used to manage the shared Lightdash ECR repository"
  default     = "xid-prod"
}

variable "aws_region" {
  description = "AWS region for the shared Lightdash ECR repository"
  default     = "us-west-2"
}

variable "ecr_repository_name" {
  description = "ECR repository name for the custom Lightdash image"
  default     = "protopie/lightdash"
}

provider "aws" {
  profile = var.aws_profile
  region  = var.aws_region
}

data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "lightdash" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    maintainer = "mamur@protopie.io"
    terraform  = "https://github.com/ProtoPie/lightdash"
    service    = "lightdash"
  }
}

resource "aws_ecr_lifecycle_policy" "lightdash" {
  repository = aws_ecr_repository.lightdash.name

  # NOTE: rules only ever SELECT images to expire. The build-image CI cache tag
  # (`buildcache`) and the moving `dev-latest` / `prod-latest` tags are never
  # matched by the rules below, so they are never expired.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images (e.g. digests left behind when a moving tag is repushed) after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 10 most recent dev- images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["dev-"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "Keep the 15 most recent prod- images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["prod-"]
          countType     = "imageCountMoreThan"
          countNumber   = 15
        }
        action = { type = "expire" }
      }
    ]
  })
}

output "repository_url" {
  value       = aws_ecr_repository.lightdash.repository_url
  description = "Full ECR repository URL used by ECS task definitions"
}

output "repository_name" {
  value       = aws_ecr_repository.lightdash.name
  description = "ECR repository name"
}
