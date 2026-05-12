# create s3 bucket for lightdash dev
resource "aws_s3_bucket" "lightdash_dev" {
  bucket = local.envs["S3_BUCKET"]

  tags = merge(
    local.common_tags,
    {
      Product = "lightdash-dev"
    }
  )
}

resource "aws_s3_bucket_ownership_controls" "lightdash_dev" {
  bucket = aws_s3_bucket.lightdash_dev.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "lightdash_dev" {
  depends_on = [aws_s3_bucket_ownership_controls.lightdash_dev]

  bucket = aws_s3_bucket.lightdash_dev.id
  acl    = "private"
}
resource "aws_s3_bucket_public_access_block" "lightdash_dev" {
  bucket = aws_s3_bucket.lightdash_dev.id

  block_public_acls       = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  block_public_policy     = true
}
resource "aws_s3_bucket_versioning" "lightdash_dev" {
  bucket = aws_s3_bucket.lightdash_dev.id

  versioning_configuration {
    status = "Enabled"
  }
}