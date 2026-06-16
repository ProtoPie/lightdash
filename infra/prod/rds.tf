# RDS master password is sourced from SSM Parameter Store (single source of truth).
# Param must exist BEFORE terraform plan/apply runs.
data "aws_ssm_parameter" "pgpassword" {
  name            = "/lightdash/${local.env_name}/PGPASSWORD"
  with_decryption = true
}

module "lightdash_db" {
  tags = merge(
    local.common_tags,
    {
      Product = "lightdash-db"
    }
  )
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.10"

  identifier = "lightdash-db"

  engine               = "postgres"
  engine_version       = "15"
  family               = "postgres15" # DB parameter group
  major_engine_version = "15"         # DB option group
  instance_class       = "db.t3.micro"
  publicly_accessible  = true

  allocated_storage     = 20
  max_allocated_storage = 100

  db_name  = "lightdash"
  username = local.envs["PGUSER"]
  password = data.aws_ssm_parameter.pgpassword.value
  # create_random_password = false
  manage_master_user_password = false
  port                        = local.envs["PGPORT"]

  iam_database_authentication_enabled = true
  skip_final_snapshot                 = true
  vpc_security_group_ids              = [aws_security_group.database_sg.id]

  # maintenance_window = "Mon:00:00-Mon:03:00"
  # backup_window      = "03:00-06:00"
  create_db_parameter_group = true
  parameters = [
    {
      apply_method = "pending-reboot"
      name         = "wal_sender_timeout"
      value        = "0"
    },
    {
      name         = "rds.force_ssl"
      value        = "0"
      apply_method = "pending-reboot"
    }
  ]
}
