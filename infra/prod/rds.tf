module "lightdash_db" {
  tags = merge(
    local.common_tags,
    {
      Product = "lightdash-db"
    }
  )
  source = "terraform-aws-modules/rds/aws"

  identifier = "lightdash-db"

  engine               = "postgres"
  engine_version       = "15"
  family               = "postgres15" # DB parameter group
  major_engine_version = "15"         # DB option group
  instance_class       = "db.t3.micro"

  allocated_storage     = 20
  max_allocated_storage = 100

  db_name  = "lightdash"
  username = local.envs["PGUSER"]
  password = local.envs["PGPASSWORD"]
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
