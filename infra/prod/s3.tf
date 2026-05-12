# create s3 bucket for lightdash
resource "aws_s3_bucket" "lightdash" {
  bucket = local.envs["S3_BUCKET"]

  tags = merge(
    local.common_tags,
    {
      Product = "lightdash"
    }
  )

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      tags,
    ]
  }
}

resource "aws_s3_bucket_ownership_controls" "lightdash" {
  bucket = aws_s3_bucket.lightdash.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }

  lifecycle {
    ignore_changes = [rule]
  }

  depends_on = [aws_s3_bucket.lightdash]
}

resource "aws_s3_bucket_acl" "lightdash" {
  depends_on = [aws_s3_bucket_ownership_controls.lightdash]

  bucket = aws_s3_bucket.lightdash.id
  acl    = "private"

  lifecycle {
    ignore_changes = [acl]
  }
}

resource "aws_s3_bucket_public_access_block" "lightdash" {
  bucket = aws_s3_bucket.lightdash.id

  block_public_acls       = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  block_public_policy     = true

  lifecycle {
    ignore_changes = [
      block_public_acls,
      ignore_public_acls,
      restrict_public_buckets,
      block_public_policy
    ]
  }
}

resource "aws_s3_bucket_versioning" "lightdash" {
  bucket = aws_s3_bucket.lightdash.id

  versioning_configuration {
    status = "Enabled"
  }

  lifecycle {
    ignore_changes = [versioning_configuration]
  }
}